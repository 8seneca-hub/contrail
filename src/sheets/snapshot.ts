import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Doc } from '../types.js'

export interface SheetSnapshot {
  spreadsheetId: string
  range: string
  values: string[][]
  /** Hash of `values`, recorded as the write guard's `ifHash` baseline on the next push. */
  hash: string
  /** ISO timestamp of the last successful live read. */
  readAt: string
  /** True when the most recent `pull` attempt's live read failed and this is the last known-good snapshot. */
  stale?: boolean
}

export interface SnapshotFile {
  version: 1
  snapshots: Record<string, SheetSnapshot>
}

/**
 * Snapshots live BESIDE the doc (same directory, `<name>.sheets.json`), not in a shared cache
 * directory — so a build works offline, and the snapshot is a plain file a human can read, diff,
 * or hand-edit before a `push`.
 */
export function snapshotPathFor(doc: Doc): string {
  return doc.absPath.replace(/\.md$/, '.sheets.json')
}

export function snapshotKey(spreadsheetId: string, range: string): string {
  return `${spreadsheetId}::${range}`
}

export function sheetUrlFor(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
}

export function loadSnapshotFile(doc: Doc): SnapshotFile {
  const path = snapshotPathFor(doc)
  if (!existsSync(path)) return { version: 1, snapshots: {} }
  return JSON.parse(readFileSync(path, 'utf8')) as SnapshotFile
}

export function saveSnapshotFile(doc: Doc, file: SnapshotFile): void {
  writeFileSync(snapshotPathFor(doc), `${JSON.stringify(file, null, 2)}\n`)
}

/** Read-only lookup used by the emitters — synchronous, and never touches the network. */
export function getSnapshot(doc: Doc, spreadsheetId: string, range: string): SheetSnapshot | undefined {
  return loadSnapshotFile(doc).snapshots[snapshotKey(spreadsheetId, range)]
}
