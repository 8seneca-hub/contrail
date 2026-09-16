#!/usr/bin/env node
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { globSync } from 'tinyglobby'
import { checkDocs, checkExitCode, docStatusReport, writeLlmsTxt, writeSiteLlmsTxt } from './check.js'
import { findConfigPath, loadConfig, readProjectMeta } from './config.js'
import { contextEmptyMessage, contextQuery, contextRule, isTaskType, TASK_TYPES, type TaskType } from './context.js'
import { defaultCliRunner, deploy, parseDeployAudience, parseDeployTarget } from './deploy.js'
import { createRailwayTransport } from './deploy/railway.js'
import { createPlaneDocsTransport } from './deploy/plane-docs.js'
import type { DeployTransport } from './deploy/transport.js'
import { buildSite, docsForAudience } from './emit/site.js'
import { loadLock, saveLock } from './lock.js'
import { parseDoc } from './parse.js'
import { PlaneApiError, PlaneClient } from './plane/client.js'
import { publishDocs, type PublishOptions, type PublishResult } from './plane/publish.js'
import type { PlaneApi, PlaneProjectApi } from './plane/client.js'
import {
  CONFIG_TEMPLATE,
  deriveIdentifier,
  runInitTemplate,
  scaffoldDoc,
  type PlaneTarget,
  type ScaffoldResult,
} from './scaffold.js'
import { credentialsPathFor, createGoogleSheetsClient } from './sheets/client.js'
import { pullSheets, pushSheets, type PullResult, type PushResult } from './sheets/sync.js'
import type { Audience, Config, Doc, Lock } from './types.js'

export function runInit(cwd: string): string {
  const path = join(cwd, 'contrail.config.ts')
  if (existsSync(path)) throw new Error(`${path} already exists.`)
  writeFileSync(path, CONFIG_TEMPLATE)
  return path
}

/** Report lines for a scaffold/init run: what was created, then what was
 * skipped because it already existed — never silently dropped. */
export function scaffoldReportLines(result: ScaffoldResult): string[] {
  const lines = result.created.map((key) => `CREATED  ${key}`)
  lines.push(...result.skipped.map((key) => `SKIPPED  ${key} (already exists)`))
  lines.push(`${result.created.length} created, ${result.skipped.length} skipped.`)
  return lines
}

export function findDocs(config: Config): string[] {
  return globSync(config.docs, { cwd: config.root, absolute: true }).sort()
}

/** Blocked documents mean someone's edit in Plane would be discarded; that must never look like success. */
export function exitCodeFor(result: PublishResult): number {
  return result.blocked.length > 0 ? 1 : 0
}

/** The one `--only` filter predicate. Every command narrows via this, never a reimplementation of it. */
export function filterByOnly(docs: Doc[], only: string | undefined): Doc[] {
  return docs.filter((doc) => !only || doc.key.includes(only))
}

/**
 * Assembles the `docs`/`knownKeys` pair for `publishDocs`. `docs` is what
 * `--only` narrows to publish; `knownKeys` is always the FULL set of document
 * keys found on disk, regardless of `--only`. The archive sweep in
 * `publishDocs` must reason about `knownKeys`, never the filtered `docs` —
 * otherwise `--only` (or a no-match filter) archives every unrelated page.
 */
export function publishArgsFor(
  allDocs: Doc[],
  only: string | undefined,
): { docs: Doc[]; knownKeys: string[] } {
  return { docs: filterByOnly(allDocs, only), knownKeys: allDocs.map((doc) => doc.key) }
}

/** The blocked-document safety warning. Names the document and warns that `--force` discards its edit. */
export function blockedMessageFor(key: string): string[] {
  return [
    `BLOCKED  ${key} was edited in Plane since the last publish; nothing was written.`,
    '         Re-publish with --force only if that edit can be discarded.',
  ]
}

/** Resolves a `contrail sheet <action> <doc>` positional to the parsed `Doc` it names, matching by
 * absolute path exactly like every other command matches documents it already parsed. */
export function resolveDocArg(allDocs: Doc[], docArg: string): Doc | undefined {
  const target = resolve(process.cwd(), docArg)
  return allDocs.find((doc) => doc.absPath === target)
}

/** A `pull` that fell back to a cached snapshot: names the range and says why, so it is never
 * mistaken for a normal refresh. */
export function sheetStaleMessageFor(key: string): string {
  return `STALE      ${key} (live read failed; kept the cached snapshot)`
}

/** The sheet write guard's refusal, named and with the same `--force` escape hatch as
 * `blockedMessageFor` — a spreadsheet range is somebody's working document too. */
export function sheetBlockedMessageFor(key: string): string[] {
  return [
    `BLOCKED  ${key} was edited in the Sheet since the last pull; nothing was written.`,
    '         Re-push with --force only if that edit can be discarded.',
  ]
}

/**
 * Archiving is the most destructive thing contrail does, and the multi-repo
 * glob means a repo that is not cloned (or on a branch without its docs) can
 * silently archive that repo's pages. Name each one instead of only a count,
 * and say clearly when a dry run means nothing actually happened yet.
 */
export function archivedMessageFor(key: string, dryRun: boolean): string {
  return dryRun ? `WOULD ARCHIVE  ${key}` : `ARCHIVED       ${key}`
}

/**
 * The publish-and-save sequence, extracted so a crash mid-publish is exercised
 * against the real `saveLock` path in tests, the way `exitCodeFor` and
 * `publishArgsFor` are. `publishDocs` mutates `lock` in place, so whatever
 * progress it made before throwing — including the provisional entry written
 * right after `createPage` — is already in `lock` and must reach disk even
 * when the publish itself fails. The error still propagates: a failed publish
 * must never look like success.
 */
export async function publishAndSave(args: {
  config: Config
  docs: Doc[]
  client: PlaneApi
  lock: Lock
  cacheDir: string
  knownKeys: string[]
  options: PublishOptions
}): Promise<PublishResult> {
  try {
    return await publishDocs({
      config: args.config,
      docs: args.docs,
      client: args.client,
      lock: args.lock,
      cacheDir: args.cacheDir,
      knownKeys: args.knownKeys,
      options: args.options,
    })
  } finally {
    if (!args.options.dryRun) saveLock(args.config.root, args.lock)
  }
}

/**
 * `--out` defaults to `<config.root>/site`; a relative `--out` resolves against `config.root`.
 *
 * Refuses when that resolves to `config.root` itself (an `--out .`, typically): `buildSite` now
 * clears its output directory before every build (see the comment on `cleanOutDir` in
 * `emit/site.ts`), and `config.root` is where `contrail.config.ts` and `docs/` live — the project
 * this build reads from, not a build artifact. Catch it here, before any file is touched, rather
 * than let `site`/`deploy` hand `buildSite` a directory whose "previous run's leftovers" are the
 * entire project.
 */
export function siteOutDirFor(config: Config, out: string | undefined): string {
  const outDir = resolve(config.root, out ?? 'site')
  if (outDir === resolve(config.root)) {
    throw new Error(
      `Refusing to use ${outDir} as the build output directory — it is the project root, where ` +
        'contrail.config.ts and docs/ live. contrail clears this directory before every build, so ' +
        'that would erase the project it just read from. Choose a subdirectory, e.g. `--out site`.',
    )
  }
  return outDir
}

/**
 * Which of the two deployed addresses a build's own pages should claim as
 * their site: `internalUrl` for the default (everything) build, `clientUrl`
 * once `--audience client` narrows it. Either may be unconfigured — most
 * trees haven't deployed yet — in which case the build keeps working with
 * relative links (`buildSite`/`buildLlmsTxt` both treat `undefined` this way).
 */
export function siteUrlFor(config: Config, audience: Audience | undefined): string | undefined {
  return audience === 'client' ? config.site?.clientUrl : config.site?.internalUrl
}

/**
 * The only valid `--audience` values: `'client'`, or omitted (which means
 * "everything"). Anything else — including `'internal'`, which sounds
 * plausible but is not a build mode — is a usage error, not a silent
 * fall-through to "publish everything".
 */
export function parseAudienceFlag(value: string | undefined): Audience | undefined {
  if (value === undefined) return undefined
  if (value === 'client') return 'client'
  throw new Error(`Unknown --audience '${value}'. Only 'client' is supported (omit the flag for all documents).`)
}

/** The message printed when a client build has nothing to publish — an empty output directory must
 * never look like an accident or a silent success; it must say plainly why it is empty. */
export function emptyClientSiteMessage(): string {
  return (
    'contrail site --audience client: 0 documents are marked `audience: client` — the output is an ' +
    'empty site. This is not an error: it means nothing in this project has been classified for the ' +
    'client yet.'
  )
}

/** One line per finding: severity, rule id, location, then the actionable message. */
export function formatFinding(f: { doc: string; line?: number; rule: string; message: string; severity: string }): string {
  const where = f.line ? `${f.doc}:${f.line}` : f.doc
  return `${f.severity.toUpperCase().padEnd(5)} [${f.rule}] ${where}  ${f.message}`
}

/** The real yes/no prompt `contrail deploy` uses interactively (guard 2) — reads one line from
 * stdin. Tests inject their own `ConfirmFn` instead; this is never exercised there. */
async function readlineConfirm(message: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(message)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

function requireApiKey(): string {
  const key = process.env.PLANE_API_KEY
  if (!key) {
    throw new Error('PLANE_API_KEY is not set. Export it; it must never be stored in a config file.')
  }
  return key
}

export interface PlaneTargetRequest {
  baseUrl?: string
  workspace?: string
  projectId?: string
  name: string
  identifier?: string
}

/** Resolve the Plane project `init` should wire the new config to, creating it
 * when no `--project-id` was given.
 *
 * `--plane-url` and `--workspace` are required together: a base URL with no
 * workspace addresses nothing, and skipping the Plane step on a half-given pair
 * would leave a config that looks wired and is not.
 */
export async function resolvePlaneTarget(
  request: PlaneTargetRequest,
  createClient: (opts: { baseUrl: string; workspace: string; apiKey: string }) => PlaneProjectApi = (opts) =>
    new PlaneClient(opts),
): Promise<PlaneTarget> {
  const { baseUrl, workspace } = request
  if (!baseUrl || !workspace) {
    throw new Error('--plane-url and --workspace must be given together.')
  }

  const normalisedBaseUrl = baseUrl.replace(/\/+$/, '')
  if (request.projectId) {
    return { baseUrl: normalisedBaseUrl, workspace, projectId: request.projectId }
  }

  const identifier = request.identifier ?? deriveIdentifier(request.name)
  if (!identifier) {
    throw new Error(`Cannot derive a Plane project identifier from '${request.name}'. Pass --identifier.`)
  }

  const client = createClient({ baseUrl: normalisedBaseUrl, workspace, apiKey: requireApiKey() })
  try {
    const project = await client.createProject({ name: request.name, identifier })
    return { baseUrl: normalisedBaseUrl, workspace, projectId: project.id }
  } catch (error) {
    if (error instanceof PlaneApiError && error.status === 409) {
      throw new Error(
        `Plane already has a project with identifier '${identifier}' in workspace '${workspace}'. ` +
          'Pass --identifier for a different one, or --project-id to write docs into the existing project.',
        { cause: error },
      )
    }
    throw error
  }
}

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      only: { type: 'string' },
      out: { type: 'string' },
      audience: { type: 'string' },
      target: { type: 'string' },
      prod: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      index: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      template: { type: 'string' },
      client: { type: 'string' },
      project: { type: 'string' },
      'start-date': { type: 'string' },
      'plane-url': { type: 'string' },
      workspace: { type: 'string' },
      identifier: { type: 'string' },
      'project-id': { type: 'string' },
      task: { type: 'string' },
      limit: { type: 'string' },
    },
  })

  const command = positionals[0] ?? 'help'

  if (command === 'help') {
    console.log(
      'contrail init [--template agency-project] ' +
        '[--plane-url <url> --workspace <slug> [--project <name>] [--identifier <KEY>] [--project-id <uuid>]] | ' +
        'build | status [--json] | ' +
        'publish [--dry-run] [--force] [--only <substring>] [--audience client] | ' +
        'site [--out <dir>] [--audience client] | check [--strict] [--index] [--audience client] [--json] | ' +
        'scaffold <docKind> <path> [--json] | sheet pull <doc> | sheet push <doc> [--force] | ' +
        'deploy [--audience client|internal] [--target vercel|plane|railway] [--prod] [--dry-run] [--yes] | ' +
        `context [--task <${TASK_TYPES.join('|')}>] [keywords...] [--audience client] [--json] [--limit <n>]`,
    )
    return 0
  }

  if (command === 'init') {
    if (values.template === undefined) {
      console.log(`Created ${runInit(process.cwd())}`)
      return 0
    }
    if (values.template !== 'agency-project') {
      console.error(`Unknown template '${values.template}'. Only 'agency-project' is supported.`)
      return 2
    }
    const projectName = values.project ?? basename(process.cwd())
    let plane: PlaneTarget | undefined
    if (values['plane-url'] !== undefined || values.workspace !== undefined) {
      try {
        plane = await resolvePlaneTarget({
          baseUrl: values['plane-url'],
          workspace: values.workspace,
          projectId: values['project-id'],
          name: projectName,
          identifier: values.identifier,
        })
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return 1
      }
    }

    const result = runInitTemplate(process.cwd(), {
      client: values.client,
      project: values.project,
      startDate: values['start-date'],
      plane,
    })
    for (const line of scaffoldReportLines(result)) console.log(line)
    if (plane) {
      console.log(`Plane project  ${plane.projectId}`)
      console.log(`Docs tab       ${plane.baseUrl}/${plane.workspace}/projects/${plane.projectId}/docs/`)
    }
    return 0
  }

  if (command === 'scaffold') {
    const [, docKind, path] = positionals
    if (!docKind || !path) {
      const message = 'Usage: contrail scaffold <docKind> <path>'
      if (values.json) console.log(JSON.stringify({ error: message }))
      else console.error(message)
      return 2
    }
    try {
      const written = scaffoldDoc(docKind, resolve(process.cwd(), path))
      if (values.json) console.log(JSON.stringify({ created: written }))
      else console.log(`Created ${written}`)
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (values.json) console.log(JSON.stringify({ error: message }))
      else console.error(message)
      return 1
    }
  }

  if (command === 'deploy') {
    let deployAudience: Audience
    let deployTarget: ReturnType<typeof parseDeployTarget>
    try {
      deployAudience = parseDeployAudience(values.audience)
      deployTarget = parseDeployTarget(values.target)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 2
    }

    const config = loadConfig(findConfigPath(process.cwd()))
    const allDocs = findDocs(config).map((path) => parseDoc(path, config.root))

    // Only the self-hosted targets need a transport, and each one is built from the matching
    // `selfhost` config. `deploy()` itself reports the actionable error when the config is absent
    // or names the other target, so nothing here has to explain a mismatch.
    let transport: DeployTransport | undefined
    if (config.selfhost?.target === 'railway' && deployTarget === 'railway') {
      transport = createRailwayTransport(defaultCliRunner, {
        volume: config.selfhost.volume,
        service: config.selfhost.service,
      })
    } else if (config.selfhost?.target === 'plane' && deployTarget === 'plane') {
      transport = createPlaneDocsTransport({
        baseUrl: config.plane.baseUrl,
        workspace: config.plane.workspace,
        projectId: config.selfhost.projectId,
        apiKey: requireApiKey(),
      })
    }

    try {
      const result = await deploy({
        config,
        docs: allDocs,
        audience: deployAudience,
        target: deployTarget,
        prod: values.prod,
        dryRun: values['dry-run'],
        yes: values.yes,
        outDir: siteOutDirFor(config, values.out),
        runner: defaultCliRunner,
        confirm: readlineConfirm,
        transport,
      })
      if (result.status === 'declined') {
        console.log('Deploy cancelled — nothing was published.')
        return 1
      }
      if (result.status === 'deployed') {
        const destination = result.remotePath ?? `the '${result.audience}' project`
        console.log(`Deployed ${result.docCount} document(s), ${result.fileCount} file(s), to ${destination}.`)
      }
      return 0
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  let audience: Audience | undefined
  try {
    audience = parseAudienceFlag(values.audience)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const config = loadConfig(findConfigPath(process.cwd()))
  const allDocs = findDocs(config).map((path) => parseDoc(path, config.root))
  const { docs, knownKeys } = publishArgsFor(allDocs, values.only)

  if (command === 'build') {
    console.log(`${docs.length} document(s) parsed with no errors.`)
    return 0
  }

  if (command === 'site') {
    const siteUrl = siteUrlFor(config, audience)
    const result = await buildSite({
      docs: allDocs,
      outDir: siteOutDirFor(config, values.out),
      cacheDir: join(config.root, '.contrail', 'cache'),
      archify: config.archify,
      audience,
      projectName: readProjectMeta(config.root)?.project,
      siteUrl,
    })

    // Ruling 2: the same --audience filter that governed the pages governs this llms.txt too — see
    // `writeSiteLlmsTxt` in check.ts, shared with both `contrail deploy` build paths. `baseUrl`
    // makes the links absolute when this build's own address is configured (Task 3): an agent can
    // fetch a document directly instead of guessing. Standalone `check --index` is untouched.
    const llmsPath = writeSiteLlmsTxt(config, allDocs, audience, result.outDir, siteUrl)

    console.log(
      `Wrote ${result.pages.length} page(s), ${result.markdownFiles} markdown file(s), and ${result.diagrams} diagram(s) to ${result.outDir}`,
    )
    console.log(`Wrote ${llmsPath}`)
    if (audience === 'client' && result.pages.length === 0) {
      console.log(emptyClientSiteMessage())
    }
    for (const link of result.defangedLinks) {
      console.log(
        `DEFANGED  ${link.doc} linked to an excluded document (${link.url}) — rewritten as plain text.`,
      )
    }
    return 0
  }

  if (command === 'check') {
    const findings = checkDocs(allDocs, { strict: values.strict, internalUrl: config.site?.internalUrl })
    const exitCode = checkExitCode(findings, Boolean(values.strict))

    let indexPath: string | undefined
    if (values.index) {
      indexPath = writeLlmsTxt(config, docsForAudience(allDocs, audience))
    }

    if (values.json) {
      const errors = findings.filter((f) => f.severity === 'error').length
      console.log(
        JSON.stringify({ findings, errors, warnings: findings.length - errors, indexPath: indexPath ?? null, exitCode }),
      )
      return exitCode
    }

    for (const finding of findings) console.log(formatFinding(finding))
    if (indexPath) console.log(`Wrote ${indexPath}`)

    if (findings.length === 0) {
      console.log('contrail check: clean.')
    } else {
      const errors = findings.filter((f) => f.severity === 'error').length
      const warnings = findings.length - errors
      console.log(`contrail check: ${errors} error(s), ${warnings} warning(s).`)
    }
    return exitCode
  }

  if (command === 'context') {
    let task: TaskType | undefined
    if (values.task !== undefined) {
      if (!isTaskType(values.task)) {
        const message = `Unknown --task '${values.task}'. Supported: ${TASK_TYPES.join(', ')}.`
        if (values.json) console.log(JSON.stringify({ error: message }))
        else console.error(message)
        return 2
      }
      task = values.task
    }
    const keywords = positionals.slice(1)
    let limit: number | undefined
    if (values.limit !== undefined) {
      limit = Number(values.limit)
      if (!Number.isInteger(limit) || limit < 0) {
        const message = `--limit must be a non-negative integer, got '${values.limit}'.`
        if (values.json) console.log(JSON.stringify({ error: message }))
        else console.error(message)
        return 2
      }
    }
    const query = { task, keywords, audience, limit }
    const results = contextQuery(allDocs, query)

    if (values.json) {
      const jsonResults = results.map(({ note: _note, ...rest }) => rest)
      console.log(
        JSON.stringify({
          rule: contextRule(query),
          results: jsonResults,
          count: results.length,
          message: results.length === 0 ? contextEmptyMessage(query) : null,
        }),
      )
      return 0
    }

    if (results.length === 0) {
      console.log(contextEmptyMessage(query))
      return 0
    }
    console.log(contextRule(query))
    console.log('')
    results.forEach((entry, i) => {
      const stale = entry.status === 'stale' ? ' (stale)' : ''
      console.log(`${i + 1}. ${entry.docKind ?? '(no docKind)'}${stale}  ${entry.path}`)
      console.log(`   ${entry.title}${entry.note ? ` — ${entry.note}` : ''}`)
    })
    return 0
  }

  if (command === 'status') {
    const lock = loadLock(config.root)
    const report = docStatusReport(allDocs)
    const stubs = new Set(report.stubs)
    const noOwner = new Set(report.noOwner)
    const overdue = new Set(report.overdue)

    const entries = docs.map((doc) => ({
      key: doc.key,
      status: doc.frontmatter.status,
      pageId: lock.docs[doc.key]?.pageId ?? null,
      stub: stubs.has(doc.key),
      noOwner: noOwner.has(doc.key),
      overdue: overdue.has(doc.key),
    }))

    if (values.json) {
      console.log(
        JSON.stringify({
          docs: entries,
          missingCoreDocs: report.missingCoreDocs.map((f) => ({ section: f.doc, message: f.message })),
          summary: { stubs: report.stubs.length, noOwner: report.noOwner.length, overdue: report.overdue.length },
        }),
      )
      return 0
    }

    for (const e of entries) {
      const flags = [e.stub && 'stub', e.noOwner && 'no-owner', e.overdue && 'overdue'].filter(Boolean)
      console.log(
        `${e.pageId ?? 'unpublished'}  ${e.status.padEnd(8)}  ${e.key}${flags.length ? `  [${flags.join(',')}]` : ''}`,
      )
    }
    console.log('')
    console.log(
      `Documentation health: ${report.stubs.length} stub(s), ${report.noOwner.length} with no owner, ` +
        `${report.overdue.length} overdue for review.`,
    )
    for (const f of report.missingCoreDocs) console.log(`  MISSING  ${f.message}`)
    return 0
  }

  if (command === 'publish') {
    const lock = loadLock(config.root)
    const client = new PlaneClient({
      baseUrl: config.plane.baseUrl,
      workspace: config.plane.workspace,
      apiKey: requireApiKey(),
    })

    const options: PublishOptions = { dryRun: values['dry-run'], force: values.force }
    const result = await publishAndSave({
      config,
      // The same audience filter `site`/`check` apply — `knownKeys` stays the
      // FULL set (see `publishArgsFor`) so the archive sweep is unaffected;
      // only which documents are ELIGIBLE to publish narrows here. Omitted,
      // `docsForAudience` returns `docs` unchanged — the default stays
      // "publish everything".
      docs: docsForAudience(docs, audience),
      client,
      lock,
      cacheDir: join(config.root, '.contrail', 'cache'),
      knownKeys,
      options,
    })

    for (const key of result.archived) {
      console.log(archivedMessageFor(key, Boolean(options.dryRun)))
    }
    console.log(
      `created ${result.created.length}, updated ${result.updated.length}, ` +
        `skipped ${result.skipped.length}, archived ${result.archived.length}`,
    )
    for (const key of result.blocked) {
      for (const line of blockedMessageFor(key)) console.error(line)
    }
    return exitCodeFor(result)
  }

  if (command === 'sheet') {
    const [, action, docArg] = positionals
    if (action !== 'pull' && action !== 'push') {
      console.error('Usage: contrail sheet pull <doc> | contrail sheet push <doc> [--force]')
      return 2
    }
    if (!docArg) {
      console.error('Usage: contrail sheet pull <doc> | contrail sheet push <doc> [--force]')
      return 2
    }
    const doc = resolveDocArg(allDocs, docArg)
    if (!doc) {
      console.error(`No document found for ${docArg}`)
      return 2
    }

    const client = await createGoogleSheetsClient(credentialsPathFor(config))

    if (action === 'pull') {
      const result: PullResult = await pullSheets(doc, client)
      for (const key of result.refreshed) console.log(`REFRESHED  ${key}`)
      for (const key of result.stale) console.log(sheetStaleMessageFor(key))
      return 0
    }

    const result: PushResult = await pushSheets(doc, client, { force: values.force })
    for (const key of result.pushed) console.log(`PUSHED   ${key}`)
    for (const key of result.blocked) {
      for (const line of sheetBlockedMessageFor(key)) console.error(line)
    }
    return result.blocked.length > 0 ? 1 : 0
  }

  console.error(`Unknown command: ${command}`)
  return 2
}

// `npm link` and a global install both put a *symlink* on PATH, so `argv[1]` is
// that symlink while `import.meta.filename` is the file it resolves to. Comparing
// them unresolved made the CLI a silent no-op when invoked by name - it exited 0
// having run nothing. Interpolating into `file://` was wrong for a second reason:
// a path containing a space or a non-ASCII character never matches the encoded
// URL that `import.meta.url` carries.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
