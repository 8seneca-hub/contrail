import { visit } from 'unist-util-visit'
import type { Code } from 'mdast'
import { parseSheetMeta } from '../blocks/sheet.js'
import type { Doc } from '../types.js'
import { SheetWriteGuardError, hashRange, type SheetsApi } from './client.js'
import { loadSnapshotFile, saveSnapshotFile, snapshotKey } from './snapshot.js'

function sheetNodes(doc: Doc): Code[] {
  const codes: Code[] = []
  visit(doc.tree, 'code', (node: Code) => {
    if (node.lang === 'sheet') codes.push(node)
  })
  return codes
}

export interface PullResult {
  /** Snapshot keys refreshed with a live read. */
  refreshed: string[]
  /** Snapshot keys that fell back to the cached snapshot because the live read failed. */
  stale: string[]
}

/**
 * Refreshes every `sheet` block's cached snapshot for one document. A read failure degrades to the
 * existing snapshot (marked `stale`) rather than aborting or writing an empty one — UNLESS there is
 * no existing snapshot to fall back to, in which case the failure must stay loud: it propagates.
 */
export async function pullSheets(doc: Doc, client: SheetsApi): Promise<PullResult> {
  const file = loadSnapshotFile(doc)
  const result: PullResult = { refreshed: [], stale: [] }

  for (const node of sheetNodes(doc)) {
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`
    const meta = parseSheetMeta(node.meta, where)
    const key = snapshotKey(meta.id, meta.range)

    try {
      const values = await client.readRange(meta.id, meta.range)
      file.snapshots[key] = {
        spreadsheetId: meta.id,
        range: meta.range,
        values,
        hash: hashRange(values),
        readAt: new Date().toISOString(),
      }
      result.refreshed.push(key)
    } catch (err) {
      const existing = file.snapshots[key]
      if (!existing) throw err
      file.snapshots[key] = { ...existing, stale: true }
      result.stale.push(key)
    }
  }

  saveSnapshotFile(doc, file)
  return result
}

export interface PushResult {
  /** Snapshot keys written back successfully. */
  pushed: string[]
  /** Snapshot keys refused by the write guard (edited in the Sheet since the last pull). */
  blocked: string[]
}

/**
 * Writes each `sheet` block's cached snapshot values back to its live range, guarded by
 * `GoogleSheetsClient.writeRange` against a concurrent human edit. The guard itself lives in
 * `client.ts`; this only reacts to it.
 */
export async function pushSheets(doc: Doc, client: SheetsApi, opts: { force?: boolean } = {}): Promise<PushResult> {
  const file = loadSnapshotFile(doc)
  const result: PushResult = { pushed: [], blocked: [] }

  for (const node of sheetNodes(doc)) {
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`
    const meta = parseSheetMeta(node.meta, where)
    const key = snapshotKey(meta.id, meta.range)
    const snapshot = file.snapshots[key]
    if (!snapshot) {
      throw new Error(
        `${where}: no cached snapshot for ${meta.id} ${meta.range} to push. Run \`contrail sheet pull\` first.`,
      )
    }

    try {
      const { hash } = await client.writeRange(meta.id, meta.range, snapshot.values, {
        ifHash: snapshot.hash,
        force: opts.force,
      })
      file.snapshots[key] = { ...snapshot, hash, readAt: new Date().toISOString(), stale: false }
      result.pushed.push(key)
    } catch (err) {
      if (err instanceof SheetWriteGuardError) {
        result.blocked.push(key)
        continue
      }
      throw err
    }
  }

  saveSnapshotFile(doc, file)
  return result
}
