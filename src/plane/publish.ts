import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import pLimit from 'p-limit'
import { collectAssets, type AssetPlan } from '../assets.js'
import { emitPlane } from '../emit/plane.js'
import { hashContent } from '../lock.js'
import type { Mmdc } from '../render/mermaid.js'
import type { Config, Doc, Lock } from '../types.js'
import { PlaneApiError, type PageRecord, type PlaneApi } from './client.js'

export const MAX_HTML_BYTES = 10 * 1024 * 1024

/** Bump when the emitter's output changes, or existing pages will never re-render. */
export const EMITTER_VERSION = '1'

const CONCURRENCY = 4

/**
 * Placeholder body written when a page is first created, before assets are
 * uploaded and the real HTML is known. Shared by the create call and the
 * provisional lock entry so their hashes never drift apart.
 */
const STUB_BODY = '<p>Publishing</p>'

export interface PublishOptions {
  dryRun?: boolean
  force?: boolean
  siteUrlFor?: (doc: Doc) => string | undefined
  /** Test seam; production uses the real mermaid renderer. */
  mmdc?: Mmdc
}

export interface PublishResult {
  created: string[]
  updated: string[]
  skipped: string[]
  blocked: string[]
  archived: string[]
}

/**
 * `siteUrl` is included so that M2 wiring up `siteUrlFor` invalidates every
 * already-published document exactly once (to add the "Interactive version"
 * callout) instead of every document being silently skipped forever. The
 * empty string for "no site URL" keeps today's hashes stable.
 */
export function contentHashFor(doc: Doc, assets: AssetPlan[], siteUrl: string | undefined): string {
  return hashContent([
    EMITTER_VERSION,
    doc.body,
    JSON.stringify(doc.frontmatter),
    ...assets.map((asset) => `${asset.id}:${asset.hash}`),
    siteUrl ?? '',
  ])
}

/**
 * `collectAssets` returns one plan per diagram/artifact OCCURRENCE, in document
 * order, because the emitter needs that order. The same diagram embedded
 * twice therefore yields two identical plans; upload each asset id once.
 */
function dedupeAssetsById(assets: AssetPlan[]): AssetPlan[] {
  const seen = new Set<string>()
  const unique: AssetPlan[] = []
  for (const asset of assets) {
    if (seen.has(asset.id)) continue
    seen.add(asset.id)
    unique.push(asset)
  }
  return unique
}

export async function publishDocs(args: {
  config: Config
  docs: Doc[]
  client: PlaneApi
  lock: Lock
  cacheDir: string
  options?: PublishOptions
  /**
   * Full set of document keys on disk, independent of any `--only` filtering
   * applied to `docs`. The archive sweep uses this to decide what is
   * missing (and therefore archivable). When omitted, falls back to the
   * keys of `docs` — this must ONLY happen when `docs` is already the
   * complete, unfiltered set, or the sweep will archive filtered-out docs.
   */
  knownKeys?: string[]
}): Promise<PublishResult> {
  const { client, lock, cacheDir } = args
  const options = args.options ?? {}
  const result: PublishResult = { created: [], updated: [], skipped: [], blocked: [], archived: [] }
  const limit = pLimit(CONCURRENCY)
  const present = new Set(args.knownKeys ?? args.docs.map((doc) => doc.key))

  await Promise.all(
    args.docs.map((doc) =>
      limit(async () => {
        const assets = await collectAssets(doc, { cacheDir, mmdc: options.mmdc })
        const siteUrl = options.siteUrlFor?.(doc)
        const contentHash = contentHashFor(doc, assets, siteUrl)
        const entry = lock.docs[doc.key]
        let isNew = !entry || entry.archived === true

        if (entry && !entry.archived) {
          let remote: PageRecord | undefined
          try {
            remote = await client.getPage(entry.pageId)
          } catch (err) {
            // The page was deleted out from under us: treat the document as
            // new rather than aborting the whole batch. Any other failure is
            // unexpected and must stay loud.
            if (err instanceof PlaneApiError && err.status === 404) {
              isNew = true
            } else {
              throw err
            }
          }

          if (remote) {
            const remoteHash = hashContent([remote.description_html])
            // A missing or empty remoteHash means we cannot prove the remote
            // body is what we last wrote (e.g. a hand-edited or migrated
            // lockfile). Unknown state fails safe: block, don't overwrite.
            const knownRemote = typeof entry.remoteHash === 'string' && entry.remoteHash.length > 0
            if ((!knownRemote || remoteHash !== entry.remoteHash) && !options.force) {
              result.blocked.push(doc.key)
              return
            }
            if (entry.contentHash === contentHash && !options.force) {
              result.skipped.push(doc.key)
              return
            }
          }
        }

        if (options.dryRun) {
          ;(isNew ? result.created : result.updated).push(doc.key)
          return
        }

        let pageId: string
        if (isNew) {
          pageId = (await client.createPage({ name: doc.frontmatter.title, description_html: STUB_BODY })).id
          // Provisional entry, written with the SEND-side hash before any
          // further network call: if getPage below throws, this entry still
          // exists and the next run reuses this page instead of calling
          // createPage again. Using the stub's own hash as the initial
          // baseline (rather than deferring the write until after the
          // read-back) also means a human edit landing in the gap between
          // createPage and getPage is never mistaken for "what contrail last
          // wrote" — the next run's guard will see the mismatch and block,
          // not silently overwrite it.
          lock.docs[doc.key] = { pageId, contentHash: '', remoteHash: hashContent([STUB_BODY]), assets: {} }
          // Now refine remoteHash to what Plane actually stored, in case it
          // normalized the stub on the way in. If this throws, the entry
          // above is already recoverable.
          const created = await client.getPage(pageId)
          lock.docs[doc.key] = { ...lock.docs[doc.key]!, remoteHash: hashContent([created.description_html]) }
        } else {
          pageId = entry!.pageId
        }

        const uniqueAssets = dedupeAssetsById(assets)
        const assetIds: Record<string, string> = {}
        for (const asset of uniqueAssets) {
          const bytes = readFileSync(asset.filePath)
          const upload = await client.createAssetUpload({
            name: basename(asset.filePath),
            type: asset.contentType,
            size: bytes.byteLength,
            entity_identifier: pageId,
          })
          await client.uploadAssetBytes(upload, bytes, asset.contentType, basename(asset.filePath))
          await client.confirmAttachment(pageId, upload.asset_id)
          assetIds[asset.id] = upload.asset_id
        }

        const html = emitPlane(doc, {
          assetIds,
          updated: new Date().toISOString().slice(0, 10),
          siteUrl,
        })

        const size = Buffer.byteLength(html, 'utf8')
        if (size > MAX_HTML_BYTES) {
          throw new Error(
            `${doc.key}: rendered HTML is ${size} bytes, over Plane's 10 MB page limit. ` +
              'Split the document into sub-pages.',
          )
        }

        await client.updatePage(pageId, { name: doc.frontmatter.title, description_html: html })

        // Read back what Plane actually stored, not what we sent: Plane
        // rewrites HTML into its editor schema (attribute order, self-closing
        // tags, wrappers), so hashing our own emitted `html` would make the
        // very next publish mismatch and block on every document.
        const remote = await client.getPage(pageId)

        lock.docs[doc.key] = {
          pageId,
          contentHash,
          remoteHash: hashContent([remote.description_html]),
          assets: Object.fromEntries(uniqueAssets.map((asset) => [asset.id, asset.hash])),
        }
        ;(isNew ? result.created : result.updated).push(doc.key)
      }),
    ),
  )

  for (const [key, entry] of Object.entries(lock.docs)) {
    if (present.has(key) || entry.archived) continue
    if (!options.dryRun) {
      await client.archivePage(entry.pageId)
      lock.docs[key] = { ...entry, archived: true }
    }
    result.archived.push(key)
  }

  return result
}
