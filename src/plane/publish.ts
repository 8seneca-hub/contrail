import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import pLimit from 'p-limit'
import { collectAssets, type AssetPlan } from '../assets.js'
import { emitPlane } from '../emit/plane.js'
import { hashContent } from '../lock.js'
import type { Mmdc } from '../render/mermaid.js'
import type { Config, Doc, Lock } from '../types.js'
import type { PlaneApi } from './client.js'

export const MAX_HTML_BYTES = 10 * 1024 * 1024

/** Bump when the emitter's output changes, or existing pages will never re-render. */
export const EMITTER_VERSION = '1'

const CONCURRENCY = 4

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

function contentHashFor(doc: Doc, assets: AssetPlan[]): string {
  return hashContent([
    EMITTER_VERSION,
    doc.body,
    JSON.stringify(doc.frontmatter),
    ...assets.map((asset) => `${asset.id}:${asset.hash}`),
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
}): Promise<PublishResult> {
  const { client, lock, cacheDir } = args
  const options = args.options ?? {}
  const result: PublishResult = { created: [], updated: [], skipped: [], blocked: [], archived: [] }
  const limit = pLimit(CONCURRENCY)
  const present = new Set(args.docs.map((doc) => doc.key))

  await Promise.all(
    args.docs.map((doc) =>
      limit(async () => {
        const assets = await collectAssets(doc, { cacheDir, mmdc: options.mmdc })
        const contentHash = contentHashFor(doc, assets)
        const entry = lock.docs[doc.key]
        const isNew = !entry || entry.archived === true

        if (entry && !entry.archived) {
          const remote = await client.getPage(entry.pageId)
          const remoteHash = hashContent([remote.description_html])

          if (entry.remoteHash && remoteHash !== entry.remoteHash && !options.force) {
            result.blocked.push(doc.key)
            return
          }
          if (entry.contentHash === contentHash && !options.force) {
            result.skipped.push(doc.key)
            return
          }
        }

        if (options.dryRun) {
          ;(isNew ? result.created : result.updated).push(doc.key)
          return
        }

        const pageId = isNew
          ? (await client.createPage({ name: doc.frontmatter.title, description_html: '<p>Publishing</p>' })).id
          : entry!.pageId

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
          siteUrl: options.siteUrlFor?.(doc),
        })

        const size = Buffer.byteLength(html, 'utf8')
        if (size > MAX_HTML_BYTES) {
          throw new Error(
            `${doc.key}: rendered HTML is ${size} bytes, over Plane's 10 MB page limit. ` +
              'Split the document into sub-pages.',
          )
        }

        await client.updatePage(pageId, { name: doc.frontmatter.title, description_html: html })

        lock.docs[doc.key] = {
          pageId,
          contentHash,
          remoteHash: hashContent([html]),
          assets: Object.fromEntries(uniqueAssets.map((asset) => [asset.id, asset.hash])),
        }
        ;(isNew ? result.created : result.updated).push(doc.key)
      }),
    ),
  )

  for (const [key, entry] of Object.entries(lock.docs)) {
    if (present.has(key) || entry.archived) continue
    if (!options.dryRun) await client.archivePage(entry.pageId)
    lock.docs[key] = { ...entry, archived: true }
    result.archived.push(key)
  }

  return result
}
