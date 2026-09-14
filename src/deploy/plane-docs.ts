import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DeployError } from '../deploy.js'
import type { DeployTransport } from './transport.js'

/**
 * Uploads a built site to a self-hosted Plane instance, which then serves it behind its own
 * project membership check and renders it in a Docs tab. The protocol is specified in
 * `docs/plane-docs-api-spec.md`; this module is the client half of it.
 *
 * Why this exists alongside `railway.ts`: a Railway volume behind Caddy is all-or-nothing — anyone
 * logged into Plane reaches every project's documents, including other clients' budgets. Plane's
 * own endpoint can check membership per project, which is the only place that boundary can be
 * drawn correctly.
 *
 * Three steps, in order, and the order is the point:
 *   1. POST the manifest, receive one presigned upload per file
 *   2. POST the bytes straight to object storage (presigned multipart form)
 *   3. POST commit, which flips the pointer to this build
 *
 * Until step 3 the previous build is what readers see. A half-finished upload therefore serves
 * nobody a half-finished site.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()]) ?? 'application/octet-stream'
}

export interface DocsFile {
  /** POSIX-separated path relative to the build directory — the path the site is served at. */
  path: string
  size: number
  type: string
  /** Content hash of the bytes. Two purposes: the server can verify what it received, and it can
   * recognise an object it already holds from an earlier build and copy it server-side instead of
   * making us send it again (see `reused` on the upload response). Builds are deterministic —
   * rebuilding an unchanged tree produces byte-identical output — which is what makes that safe. */
  sha256: string
}

/** Every file under `dir`, as the manifest describes them. Paths are POSIX-separated regardless of
 * platform: they become URL paths on the server, where a backslash is a character, not a
 * separator. */
export function collectDocsFiles(dir: string, base = dir): DocsFile[] {
  const files: DocsFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectDocsFiles(abs, base))
      continue
    }
    const path = relative(base, abs).split(sep).join('/')
    const bytes = readFileSync(abs)
    files.push({
      path,
      size: statSync(abs).size,
      type: contentTypeFor(path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return files
}

export interface PresignedUpload {
  path: string
  /** Absent when `reused` is true — there is nothing to send. */
  upload_data?: { url: string; fields: Record<string, string> }
  /** The server already holds these bytes from an earlier build and will copy them into this one
   * itself. Optional on the server's side: an implementation that presigns everything is correct,
   * just slower. Editing a single document changes one file out of fifty-odd, so this is the
   * difference between sending 3 KB and sending the whole site. */
  reused?: boolean
}

export interface PlaneDocsTransportOptions {
  /** Plane's base URL, e.g. `https://projects.8seneca.com`. */
  baseUrl: string
  /** Workspace slug. */
  workspace: string
  /** The project whose Docs tab this build belongs to. Access follows membership of this project. */
  projectId: string
  /** Read from `PLANE_API_KEY` by the CLI — never from a config file. */
  apiKey: string
  fetchFn?: typeof fetch
  /** Injected in tests so the manifest and the reported build are deterministic. */
  buildId?: string
  /** Files uploaded at once. Sequential uploads are slow for the 800KB diagram bundles; the
   * server does no work per file, so the ceiling here is the network. */
  concurrency?: number
}

function newBuildId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`
}

const MARKDOWN_LINK = /\]\((https?:\/\/[^\s)]+)\)/gi

/**
 * `llms.txt` is the only thing an agent has to discover what documents exist and where to fetch
 * them, so every link in it must resolve on the host this build is actually being pushed to.
 * `buildLlmsTxt` makes links absolute against `site.internalUrl`/`clientUrl` whenever either is
 * configured — right for the Vercel-hosted tree that setting was written for, wrong the moment the
 * same build is redeployed to Plane without clearing it. Nothing about the push itself would fail:
 * the upload and commit both succeed, and the index inside the finished build just names the wrong
 * host. An agent following it either 404s, or worse, silently reads a stale public copy of a
 * document that was supposed to come from behind Plane's project membership check.
 *
 * Fixing this in `buildLlmsTxt` would be wrong: relative links already resolve correctly under the
 * docs prefix, because `llms.txt` sits beside the pages it names. This is a guard against a
 * mis-configured build reaching Plane, not a defect in how the emitter builds links — so it belongs
 * here, not there.
 */
function assertLlmsTxtMatchesOrigin(localDir: string, baseUrl: string): void {
  const path = join(localDir, 'llms.txt')
  if (!existsSync(path)) return

  const expected = new URL(baseUrl).origin
  const foreign = [...readFileSync(path, 'utf8').matchAll(MARKDOWN_LINK)]
    .map((match) => match[1])
    .filter((link): link is string => link !== undefined)
    .map((link) => new URL(link).origin)
    .filter((origin) => origin !== expected)
  if (foreign.length === 0) return

  const offending = [...new Set(foreign)].join(', ')
  throw new DeployError(
    `llms.txt in ${localDir} points ${foreign.length} entr${foreign.length === 1 ? 'y' : 'ies'} at ` +
      `${offending} instead of this deploy's target, ${expected}. The build was made with site.internalUrl ` +
      `(or clientUrl, for a client-audience build) set to that host and never rebuilt for Plane. Clear it and ` +
      `rebuild before deploying — nothing was uploaded and no build was made live.`,
  )
}

/**
 * `remotePath` carries the audience (`'internal'` or `'client'`) — for this target there is no
 * filesystem path, because the server owns the layout. `deploy.ts` computes it; see
 * `remotePathFor`.
 */
export function createPlaneDocsTransport(opts: PlaneDocsTransportOptions): DeployTransport {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const fetchFn = opts.fetchFn ?? fetch
  const concurrency = opts.concurrency ?? 8

  const endpoint = (suffix: string): string =>
    `${baseUrl}/api/v1/workspaces/${opts.workspace}/projects/${opts.projectId}/docs/${suffix}`

  async function postJson(suffix: string, body: unknown): Promise<unknown> {
    const response = await fetchFn(endpoint(suffix), {
      method: 'POST',
      headers: { 'X-API-Key': opts.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new DeployError(`Plane POST docs/${suffix} failed with ${response.status}: ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : {}
  }

  return {
    name: 'plane',
    async push(localDir, remotePath, pushOpts) {
      assertLlmsTxtMatchesOrigin(localDir, baseUrl)

      const audience = remotePath
      const files = collectDocsFiles(localDir)
      const bytes = files.reduce((total, file) => total + file.size, 0)
      const buildId = opts.buildId ?? newBuildId()

      if (pushOpts.dryRun) {
        console.log(`Would upload ${files.length} file(s), ${bytes} byte(s) from ${localDir}`)
        console.log(`Would POST ${endpoint('uploads/')} (audience ${audience}, build ${buildId})`)
        console.log(`Would POST ${endpoint('commit/')} to make that build live`)
        return { filesSent: files.length, bytes }
      }

      const manifest = (await postJson('uploads/', { build_id: buildId, audience, files })) as {
        uploads?: PresignedUpload[]
      }
      const uploads = manifest.uploads ?? []

      // Every file must be accounted for: either the server presigned it, or it says it already
      // has the bytes. Anything else would silently never exist on the server, and the commit
      // below would then make a build live with a hole in it. Fail before the commit.
      const accounted = new Set(
        uploads.filter((upload) => upload.reused === true || upload.upload_data).map((upload) => upload.path),
      )
      const missing = files.filter((file) => !accounted.has(file.path))
      if (missing.length > 0) {
        throw new DeployError(
          `Plane neither presigned nor claimed to already hold ${missing.length} file(s), first: ` +
            `${missing[0]?.path}. Nothing was committed; the previous build is still live.`,
        )
      }

      const toSend = uploads.filter((upload) => upload.reused !== true && upload.upload_data)
      for (let index = 0; index < toSend.length; index += concurrency) {
        await Promise.all(
          toSend.slice(index, index + concurrency).map(async (upload) => {
            const form = new FormData()
            const uploadData = upload.upload_data!
            for (const [key, value] of Object.entries(uploadData.fields)) form.append(key, value)
            const body = readFileSync(join(localDir, ...upload.path.split('/')))
            form.append(
              'file',
              new Blob([body as unknown as BlobPart], { type: contentTypeFor(upload.path) }),
              upload.path,
            )

            // Deliberately no API key: object storage is a different trust boundary.
            const response = await fetchFn(uploadData.url, { method: 'POST', body: form })
            if (!response.ok) {
              throw new DeployError(
                `Upload of ${upload.path} failed with ${response.status}. Nothing was committed; ` +
                  'the previous build is still live.',
              )
            }
          }),
        )
      }

      await postJson('commit/', { build_id: buildId, audience })
      // `filesSent` counts what actually crossed the network, so a reusing server visibly reports
      // fewer than the build contains.
      return { filesSent: toSend.length, bytes }
    },
  }
}
