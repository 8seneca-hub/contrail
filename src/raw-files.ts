import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, posix, relative, sep } from 'node:path'
import { globSync } from 'tinyglobby'

/**
 * A piece of raw client material — a spreadsheet, a PDF, a signed proposal —
 * that travels with the build so the published documents can link to it.
 *
 * `docs/` stays markdown-only on purpose: a document is something contrail
 * parses, lints and renders, and a binary is none of those things. Raw files
 * live under their own `files` glob instead, get uploaded alongside the site,
 * and are referenced by URL from the documents that cite them. That way the
 * original survives somewhere other than one laptop, which is the whole point.
 */
export interface RawFile {
  /** Path relative to the project root, as configured. */
  sourceRel: string
  absPath: string
  /** Path inside the build, content-addressed: `files/<hash><ext>`. */
  outPath: string
  size: number
}

/** Markdown is never raw material — it is a document, and documents go through
 * the `docs` glob where they get parsed and linted. Collecting one here would
 * publish it twice, once rendered and once as a download. */
const NEVER_RAW = new Set(['.md'])

/**
 * Content-addressed so identical bytes upload once and changed bytes get a new
 * URL rather than a stale cached one — the same reason diagrams and assets are.
 * Sixteen hex characters is plenty to separate the handful of attachments one
 * project carries, and keeps the link readable.
 */
function hashFor(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

export function collectRawFiles(root: string, globs: string[] | undefined): RawFile[] {
  if (!globs || globs.length === 0) return []

  const found = globSync(globs, { cwd: root, absolute: true, onlyFiles: true }).sort()
  const files: RawFile[] = []
  for (const absPath of found) {
    const ext = extname(absPath).toLowerCase()
    if (NEVER_RAW.has(ext)) continue
    const bytes = readFileSync(absPath)
    files.push({
      sourceRel: relative(root, absPath).split(sep).join('/'),
      absPath,
      outPath: `files/${hashFor(bytes)}${ext}`,
      size: statSync(absPath).size,
    })
  }
  return files
}

/** The href a page at `rootPrefix` deep should use to reach this file. Relative
 * so it resolves under the Plane docs endpoint, which serves the build from a
 * path nobody can predict at build time. */
export function rawFileHref(file: RawFile, rootPrefix: string): string {
  return posix.join(rootPrefix, file.outPath)
}

/** A human-readable size for the link text, so a reader knows what they are
 * about to download before they click it. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
