import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { globSync } from 'tinyglobby'
import { hashContent } from './lock.js'
import { parseDoc } from './parse.js'
import type { Doc } from './types.js'

/** Written into the build directory by `contrail preview`, read back by
 * `contrail deploy`. Named with a leading dot so it never looks like a page. */
export const PREVIEW_MANIFEST = '.contrail-preview.json'

interface PreviewManifest {
  /** Document key to content hash, as built. */
  docs: Record<string, string>
}

/**
 * Records which documents a preview was built from, so a later deploy can tell
 * whether the person who approved that preview approved what is about to ship.
 *
 * The hash is of the document's own content, not the emitted HTML: the point
 * is to catch a source document edited between "looks right" and "ship it",
 * which in an agent loop is a single turn apart.
 */
export function writePreviewManifest(outDir: string, docs: Doc[]): void {
  const manifest: PreviewManifest = {
    docs: Object.fromEntries(docs.map((doc) => [doc.key, hashContent([doc.body])])),
  }
  writeFileSync(join(outDir, PREVIEW_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * The documents that no longer match the last preview taken in `outDir`:
 * edited, added or removed since. Empty when they all match.
 *
 * Empty ALSO when no preview was ever taken. The guard exists to protect a
 * confirmation that happened, and must never block a deploy from someone who
 * never asked for a preview in the first place.
 */
export function previewDrift(root: string, outDir: string, docs?: Doc[]): string[] {
  const path = join(outDir, PREVIEW_MANIFEST)
  if (!existsSync(path)) return []

  let manifest: PreviewManifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8')) as PreviewManifest
  } catch {
    // An unreadable manifest is no confirmation at all. Say so by reporting
    // drift on nothing rather than throwing: the deploy path has better
    // things to fail on than a corrupt cache file it wrote itself.
    return []
  }

  const current = new Map((docs ?? readDocs(root)).map((d) => [d.key, hashContent([d.body])]))
  const keys = new Set([...Object.keys(manifest.docs), ...current.keys()])
  return [...keys].filter((key) => manifest.docs[key] !== current.get(key)).sort()
}

/** Re-reads the documents on disk when the caller has not already parsed them
 * — the standalone-call path the tests use. `deploy` passes its own `docs`, so
 * this never double-parses on the path that matters. */
function readDocs(root: string): Doc[] {
  return globSync(['./docs/**/*.md', './*/docs/**/*.md'], { cwd: root, absolute: true })
    .sort()
    .map((abs: string) => parseDoc(abs, root))
}
