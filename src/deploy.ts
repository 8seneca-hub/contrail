import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { writeSiteLlmsTxt } from './check.js'
import { buildSite, docsForAudience } from './emit/site.js'
import { collectRawFiles } from './raw-files.js'
import type { DeployTransport } from './deploy/transport.js'
import type { Audience, Config, Doc } from './types.js'

export type DeployTarget = 'vercel' | 'railway' | 'plane'

/** `contrail deploy`'s `--target` flag. Defaults to `vercel`, the original (and still unchanged)
 * deploy path; `plane` and `railway` both take the self-hosted path below. `plane` is the
 * recommended self-hosted target — it is the only one where access follows project membership. */
export function parseDeployTarget(value: string | undefined): DeployTarget {
  if (value === undefined || value === 'vercel') return 'vercel'
  if (value === 'railway') return 'railway'
  if (value === 'plane') return 'plane'
  throw new Error(`Unknown --target '${value}'. Must be 'vercel', 'plane' or 'railway'.`)
}

/** The two targets that push a built directory through a `DeployTransport` rather than shelling
 * out to the Vercel CLI. */
export function isSelfhostTarget(target: DeployTarget): target is 'railway' | 'plane' {
  return target === 'railway' || target === 'plane'
}

/** `contrail deploy`'s own audience flag accepts `internal` explicitly (unlike `site`/`check`/
 * `publish`, whose `--audience` only ever narrows to `client`) — the deploy guard needs to know
 * which of the two Vercel projects a build is headed for even for the default, full build. */
export function parseDeployAudience(value: string | undefined): Audience {
  if (value === undefined || value === 'internal') return 'internal'
  if (value === 'client') return 'client'
  throw new Error(`Unknown --audience '${value}'. Must be 'client' or 'internal'.`)
}

/** The `buildSite`/`docsForAudience` audience filter only ever narrows to `'client'` — an
 * "internal" deploy is the ordinary unfiltered (everything) build, the same one `contrail site`
 * produces with no `--audience` flag at all. */
function siteAudienceFor(deployAudience: Audience): Audience | undefined {
  return deployAudience === 'client' ? 'client' : undefined
}

export class DeployError extends Error {}

interface LinkedProject {
  projectId?: string
  orgId?: string
  projectName?: string
}

/** Reads the Vercel CLI's own link record — `.vercel/project.json`, written by `vercel link` (or a
 * prior `vercel deploy`) — never anything contrail writes itself. `undefined` when the directory
 * has never been linked. */
export function readLinkedProject(root: string): LinkedProject | undefined {
  const path = join(root, '.vercel', 'project.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as LinkedProject
}

/** Which config field names the target Vercel project for a given audience. */
function expectedProjectFor(config: Config, audience: Audience): string | undefined {
  return audience === 'client' ? config.vercel?.clientProject : config.vercel?.internalProject
}

/**
 * Guard 1 (the wrong-project guard): the failure it prevents — an internal build landing on the
 * client's Vercel project, or vice versa — is public and irreversible, so this throws rather than
 * returning a soft result. A mismatch names both the expected and the actual project, never just
 * one, so whoever reads the error can fix either side without guessing.
 */
function assertProjectMatches(config: Config, audience: Audience, root: string): void {
  const linked = readLinkedProject(root)
  if (!linked) {
    throw new DeployError(
      `No .vercel/project.json found in ${root}. Run \`vercel link\` to connect this directory to a ` +
        'Vercel project before deploying.',
    )
  }

  const expected = expectedProjectFor(config, audience)
  const configKey = audience === 'client' ? 'vercel.clientProject' : 'vercel.internalProject'
  if (!expected) {
    throw new DeployError(
      `contrail.config.ts has no \`${configKey}\` configured — set it so contrail can verify a ${audience} ` +
        'deploy is going to the right Vercel project.',
    )
  }

  const actual = linked.projectName ?? linked.projectId ?? '(unknown)'
  if (actual !== expected) {
    throw new DeployError(
      `Refusing to deploy: this directory is linked to Vercel project '${actual}', but \`${configKey}\` ` +
        `expects '${expected}' for the ${audience} audience. Run \`vercel link\` against the right project, ` +
        `or fix \`${configKey}\` in contrail.config.ts.`,
    )
  }
}

/** Every file under `dir`, counted recursively — what `--dry-run` reports as the file count, and
 * what a real deploy is about to hand to `vercel deploy --prebuilt`. Exported for the `railway`
 * transport, which reports the same count for its own `--dry-run` output. */
export function countFiles(dir: string): number {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    count += entry.isDirectory() ? countFiles(path) : 1
  }
  return count
}

type SelfhostConfig = NonNullable<Config['selfhost']>

/** `slug` becomes a literal path segment appended to `internalPath`/`clientPath` — this pattern is
 * what keeps it from escaping via `..` or a leading `/`: no `/` or `.` character is in the allowed
 * class at all. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Guard (config shape): `selfhost` must be configured, and `internalPath`/`clientPath` must be
 * distinct. A wrong path here is a public directory on the team's own domain — stricter than the
 * Vercel equivalent, not looser — so this throws naming both paths rather than picking one to
 * trust.
 */
function assertSelfhostConfig(config: Config, target: 'railway' | 'plane'): SelfhostConfig {
  const selfhost = config.selfhost
  if (!selfhost) {
    throw new DeployError(
      `contrail.config.ts has no \`selfhost\` configured — required for \`--target ${target}\`. ` +
        (target === 'plane'
          ? 'See `selfhost: { target: \'plane\', projectId }` in the docs.'
          : 'See `selfhost: { target, volume, slug, internalPath, clientPath }` in the docs.'),
    )
  }
  // A `--target` that disagrees with the configured one would push a build somewhere nobody
  // described. Refuse rather than guess which of the two the caller meant.
  if (selfhost.target !== target) {
    throw new DeployError(
      `\`--target ${target}\` but contrail.config.ts configures \`selfhost.target: '${selfhost.target}'\`. ` +
        'Fix one of the two so they agree.',
    )
  }
  if (selfhost.target === 'railway' && selfhost.internalPath === selfhost.clientPath) {
    throw new DeployError(
      `Refusing to deploy: \`selfhost.internalPath\` and \`selfhost.clientPath\` are both ` +
        `'${selfhost.internalPath}' — an internal build must never be able to land on the client ` +
        'path, or vice versa. Configure two distinct paths.',
    )
  }
  return selfhost
}

/** Guard (slug validation): `slug` becomes a path segment, so it must not be able to escape the
 * configured `internalPath`/`clientPath` via `..` or an absolute path. */
function assertValidSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new DeployError(
      `Invalid \`selfhost.slug\` '${slug}': must match ${SLUG_PATTERN} — lowercase letters, ` +
        'digits, and hyphens only, and must not start with a hyphen.',
    )
  }
}

/**
 * Where a build lands on the target. For `railway` that is a directory the proxy serves; for
 * `plane` the server owns the layout entirely, so the only thing it needs from us is which
 * audience this build is — the transport sends it as the `audience` field and the server keys its
 * build pointer on it (`docs/plane-docs-api-spec.md`).
 */
function remotePathFor(selfhost: SelfhostConfig, audience: Audience): string {
  if (selfhost.target === 'plane') return audience
  const base = audience === 'client' ? selfhost.clientPath : selfhost.internalPath
  return `${base}/${selfhost.slug}`
}

/**
 * Guard (empty-build refusal): a failed build must never be allowed to overwrite a live site with
 * nothing. Runs after the build, before any transport is touched, and reports exactly what it
 * found so the failure is actionable. Exported so it can be unit-tested directly against fixture
 * directories — `buildSite` always writes a root `index.html` on success, so this branch is not
 * reachable by driving a normal build through `deploy()` end to end.
 */
export function assertBuildNotEmpty(outDir: string): void {
  if (!existsSync(outDir)) {
    throw new DeployError(`Refusing to deploy: build output directory ${outDir} does not exist.`)
  }
  const entries = readdirSync(outDir)
  if (entries.length === 0) {
    throw new DeployError(
      `Refusing to deploy: build output directory ${outDir} is empty. A failed build must never ` +
        'overwrite a live site.',
    )
  }
  if (!existsSync(join(outDir, 'index.html'))) {
    throw new DeployError(
      `Refusing to deploy: build output directory ${outDir} has ${entries.length} file(s) but no ` +
        'index.html. A failed build must never overwrite a live site.',
    )
  }
}

export interface CliResult {
  code: number
}

/** Shells out to an external CLI. Injected in tests so a test never invokes the real `vercel`
 * binary; `defaultCliRunner` (below) is what `contrail deploy` actually runs with. */
export type CliRunner = (command: string, args: string[]) => Promise<CliResult>

/**
 * `stdio: 'inherit'` is load-bearing: the Vercel CLI owns authentication end to end, including any
 * login prompt or token it prints, and none of that may ever pass through contrail's own stdout,
 * a log file, or a returned string — contrail must never read, store, or log a token.
 */
export function defaultCliRunner(command: string, args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code: code ?? 1 }))
  })
}

/** Asks a yes/no question and resolves the answer. Injected in tests; `cli.ts` supplies a real
 * stdin-reading implementation for interactive use. */
export type ConfirmFn = (message: string) => Promise<boolean>

export interface DeployOptions {
  config: Config
  /** Every document contrail knows about — `deploy` builds the site itself, the same way
   * `contrail site` does, so it needs the full set regardless of which audience narrows it. */
  docs: Doc[]
  audience?: string
  /** Defaults to `'vercel'` — the original path, unchanged. `'railway'` builds the same way but
   * pushes through `transport` instead of shelling out to the Vercel CLI. */
  target?: DeployTarget
  prod?: boolean
  dryRun?: boolean
  yes?: boolean
  /** Where to build the site before deploying. Defaults to `<config.root>/site`. */
  outDir?: string
  runner: CliRunner
  /** Required only when guard 2 can actually fire (`--prod --audience client` without `--yes`). */
  confirm?: ConfirmFn
  /** Required only when `target` is `'railway'` (or any future self-hosted target) — never used
   * for `'vercel'`. Injected so tests never invoke a real transport CLI. */
  transport?: DeployTransport
}

export type DeployStatus = 'deployed' | 'dry-run' | 'declined'

export interface DeployResult {
  status: DeployStatus
  audience: Audience
  command: string[]
  fileCount: number
  docCount: number
  /** Only set for a self-hosted target — the resolved `<internalPath|clientPath>/<slug>`. */
  remotePath?: string
}

/**
 * `contrail deploy`: builds the site for the chosen audience, then — guards permitting — shells out
 * to `vercel deploy --prebuilt` against the built directory. contrail never touches Vercel
 * authentication itself; the CLI it invokes owns that entirely.
 */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const audience = parseDeployAudience(options.audience)
  const outDir = options.outDir ?? join(options.config.root, 'site')

  const target = options.target ?? 'vercel'
  if (isSelfhostTarget(target)) {
    return deploySelfhost(options, audience, outDir, target)
  }

  // Guard 1 runs before anything is built: a wrong-project deploy is the single worst outcome this
  // tool can produce, so there is no reason to spend time building first.
  assertProjectMatches(options.config, audience, options.config.root)

  const emitted = docsForAudience(options.docs, siteAudienceFor(audience))
  await buildSite({
    docs: options.docs,
    outDir,
    cacheDir: join(options.config.root, '.contrail', 'cache'),
    audience: siteAudienceFor(audience),
    rawFiles: collectRawFiles(options.config.root, options.config.files),
  })
  // `llms.txt` is the only thing an agent has to discover what documents exist
  // (docs/plane-docs-api-spec.md) — every build path writes it, not just `contrail site`, using the
  // same audience that just filtered the pages. No `baseUrl`: unlike `contrail site`, `deploy`
  // never bakes `site.internalUrl`/`clientUrl` into the pages it builds either, so this index stays
  // relative to match them.
  writeSiteLlmsTxt(options.config, options.docs, siteAudienceFor(audience), outDir)

  const command = ['deploy', '--prebuilt', outDir, ...(options.prod ? ['--prod'] : [])]
  const fileCount = countFiles(outDir)

  if (options.dryRun) {
    console.log(`Would run: vercel ${command.join(' ')}`)
    console.log(`${fileCount} file(s) built to ${outDir}`)
    return { status: 'dry-run', audience, command, fileCount, docCount: emitted.length }
  }

  // Guard 2: a client production deploy is outward-facing and, in the way that matters, permanent —
  // a client may read it the moment it lands. Print exactly what is about to publish and require an
  // explicit yes, unless the caller already said `--yes`.
  if (audience === 'client' && options.prod && !options.yes) {
    console.log(`About to publish ${emitted.length} document(s) to the client production URL:`)
    for (const doc of emitted) console.log(`  - ${doc.frontmatter.title}`)
    const confirmed = options.confirm ? await options.confirm('Continue? [y/N] ') : false
    if (!confirmed) {
      return { status: 'declined', audience, command, fileCount, docCount: emitted.length }
    }
  }

  const result = await options.runner('vercel', command)
  if (result.code !== 0) {
    throw new DeployError(`vercel exited with code ${result.code}.`)
  }

  return { status: 'deployed', audience, command, fileCount, docCount: emitted.length }
}

/**
 * `contrail deploy --target railway` (or any future self-hosted target): same build as the Vercel
 * path, then — guards permitting — a `DeployTransport.push` instead of a Vercel CLI invocation.
 * Nothing here knows about Railway specifically; that lives entirely in `src/deploy/railway.ts`.
 */
async function deploySelfhost(
  options: DeployOptions,
  audience: Audience,
  outDir: string,
  target: 'railway' | 'plane',
): Promise<DeployResult> {
  const selfhost = assertSelfhostConfig(options.config, target)
  if (selfhost.target === 'railway') assertValidSlug(selfhost.slug)
  const remotePath = remotePathFor(selfhost, audience)

  const emitted = docsForAudience(options.docs, siteAudienceFor(audience))
  await buildSite({
    docs: options.docs,
    outDir,
    cacheDir: join(options.config.root, '.contrail', 'cache'),
    audience: siteAudienceFor(audience),
    rawFiles: collectRawFiles(options.config.root, options.config.files),
  })
  // Same as the vercel path above: every build path writes its own llms.txt, relative-only since
  // this build bakes in no absolute site address either.
  writeSiteLlmsTxt(options.config, options.docs, siteAudienceFor(audience), outDir)

  // Empty-build guard runs after the build, before the transport is ever touched.
  assertBuildNotEmpty(outDir)

  if (!options.transport) {
    throw new DeployError(
      `\`--target ${target}\` requires a transport (none was provided) — see ` +
        (target === 'plane'
          ? 'createPlaneDocsTransport in src/deploy/plane-docs.ts.'
          : 'createRailwayTransport in src/deploy/railway.ts.'),
    )
  }

  const pushResult = await options.transport.push(outDir, remotePath, { dryRun: options.dryRun })
  const fileCount = pushResult.filesSent

  const status: DeployStatus = options.dryRun ? 'dry-run' : 'deployed'
  return { status, audience, command: [], fileCount, docCount: emitted.length, remotePath }
}
