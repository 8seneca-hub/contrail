import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { visit } from 'unist-util-visit'
import type { Code } from 'mdast'
import { parseArchifyMeta, type ArchifyMeta } from './blocks/archify.js'
import { parseArtifactMeta } from './blocks/artifact.js'
import { diagramHash, renderMermaid, type Mmdc } from './render/mermaid.js'
import { renderArchify, type ArchifyOptions } from './render/archify.js'
import type { Doc } from './types.js'

export interface AssetPlan {
  /** Stable identity computed from the document alone. */
  id: string
  /** Content hash, used for change detection. */
  hash: string
  filePath: string
  contentType: string
}

export function assetIdForDiagram(source: string): string {
  return `mermaid:${diagramHash(source)}`
}

export function assetIdForFile(fallbackPath: string): string {
  return `file:${fallbackPath}`
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export async function collectAssets(
  doc: Doc,
  opts: { cacheDir: string; mmdc?: Mmdc },
): Promise<AssetPlan[]> {
  const codes: Code[] = []
  visit(doc.tree, 'code', (node: Code) => {
    if (node.lang === 'mermaid' || node.lang === 'artifact') codes.push(node)
  })

  const plans: AssetPlan[] = []
  for (const node of codes) {
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`

    if (node.lang === 'mermaid') {
      const rendered = await renderMermaid(node.value, opts.cacheDir, opts.mmdc)
      plans.push({
        id: assetIdForDiagram(node.value),
        hash: rendered.hash,
        filePath: rendered.pngPath,
        contentType: 'image/png',
      })
      continue
    }

    const meta = parseArtifactMeta(node.meta, where)
    const filePath = resolve(dirname(doc.absPath), meta.fallback)
    if (!existsSync(filePath)) {
      throw new Error(`${where}: artifact fallback image not found: ${meta.fallback}`)
    }
    const bytes = readFileSync(filePath)
    plans.push({
      id: assetIdForFile(meta.fallback),
      hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      filePath,
      contentType: CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    })
  }
  return plans
}

/**
 * An archify diagram is an ~800KB interactive HTML artifact, not an
 * uploadable image — it must never enter `AssetPlan` (Plane's image-upload
 * pipeline would try to send it to an image endpoint). It gets its own plan
 * type and its own collection pass; `collectAssets` above is untouched.
 */
export interface DiagramPlan {
  /** Stable identity computed from the document alone. */
  id: string
  /** Content hash of the IR file, used for change detection and caching. */
  hash: string
  htmlPath: string
  irPath: string
  meta: ArchifyMeta
}

export function diagramIdFor(hash: string): string {
  return `archify:${hash}`
}

export async function collectDiagrams(
  doc: Doc,
  opts: { cacheDir: string; archify?: ArchifyOptions },
): Promise<DiagramPlan[]> {
  const codes: Code[] = []
  visit(doc.tree, 'code', (node: Code) => {
    if (node.lang === 'archify') codes.push(node)
  })

  const plans: DiagramPlan[] = []
  for (const node of codes) {
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`
    const meta = parseArchifyMeta(node.meta, where)
    const irPath = resolve(dirname(doc.absPath), meta.src)
    if (!existsSync(irPath)) {
      throw new Error(`${where}: archify IR file not found: ${meta.src}`)
    }
    const rendered = await renderArchify(meta.type, irPath, opts.cacheDir, opts.archify)
    plans.push({
      id: diagramIdFor(rendered.hash),
      hash: rendered.hash,
      htmlPath: rendered.htmlPath,
      irPath: rendered.irPath,
      meta,
    })
  }
  return plans
}
