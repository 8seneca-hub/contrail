import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDoc } from '../src/parse.js'
import { SheetWriteGuardError, hashRange, type SheetsApi } from '../src/sheets/client.js'
import { getSnapshot, loadSnapshotFile, saveSnapshotFile, snapshotKey, snapshotPathFor } from '../src/sheets/snapshot.js'
import { pullSheets, pushSheets } from '../src/sheets/sync.js'
import type { Doc } from '../src/types.js'

const DOC = `---
title: Estimate
summary: S
status: current
---

\`\`\`sheet {id=sheet-1, range="Estimate!A1:B2", summary="Effort estimate."}
\`\`\`
`

function fixture(body: string = DOC): { root: string; doc: Doc } {
  const root = mkdtempSync(join(tmpdir(), 'contrail-sheets-'))
  writeFileSync(join(root, 'doc.md'), body)
  return { root, doc: parseDoc(join(root, 'doc.md'), root) }
}

/** A stateful fake: `readRange` returns whatever `writeRange` last stored (or the seed), so a
 * pull-then-push round trip is exercised for real rather than faked independently. */
function fakeClient(seed: Record<string, string[][]> = {}, overrides: Partial<SheetsApi> = {}): SheetsApi & {
  calls: string[]
} {
  const store = new Map<string, string[][]>(Object.entries(seed))
  const calls: string[] = []
  const base: SheetsApi = {
    readRange: async (id, range) => {
      calls.push(`read:${id}:${range}`)
      return store.get(`${id}::${range}`) ?? []
    },
    writeRange: async (id, range, values, opts) => {
      calls.push(`write:${id}:${range}`)
      const current = store.get(`${id}::${range}`) ?? []
      if (!opts.force) {
        const known = typeof opts.ifHash === 'string' && opts.ifHash.length > 0
        if (!known || hashRange(current) !== opts.ifHash) {
          throw new SheetWriteGuardError(id, range, `${range} in ${id} was edited since the last read.`)
        }
      }
      store.set(`${id}::${range}`, values)
      return { hash: hashRange(values) }
    },
    createFromTemplate: async () => ({ spreadsheetId: 'new-id' }),
  }
  return { ...base, ...overrides, calls }
}

describe('pullSheets', () => {
  it('creates a snapshot beside the doc on a fresh pull', async () => {
    const { doc } = fixture()
    const client = fakeClient({ 'sheet-1::Estimate!A1:B2': [['a', 'b'], ['1', '2']] })

    const result = await pullSheets(doc, client)

    expect(result.refreshed).toEqual([snapshotKey('sheet-1', 'Estimate!A1:B2')])
    expect(result.stale).toEqual([])
    expect(existsSync(snapshotPathFor(doc))).toBe(true)

    const snapshot = getSnapshot(doc, 'sheet-1', 'Estimate!A1:B2')
    expect(snapshot?.values).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(snapshot?.stale).toBeUndefined()
    expect(snapshot?.hash).toBe(hashRange([['a', 'b'], ['1', '2']]))
    expect(typeof snapshot?.readAt).toBe('string')
  })

  it('degrades to the cached snapshot and marks it stale when the live read fails', async () => {
    const { doc } = fixture()
    // Seed an existing good snapshot as if a prior pull had succeeded.
    saveSnapshotFile(doc, {
      version: 1,
      snapshots: {
        [snapshotKey('sheet-1', 'Estimate!A1:B2')]: {
          spreadsheetId: 'sheet-1',
          range: 'Estimate!A1:B2',
          values: [['old', 'data']],
          hash: hashRange([['old', 'data']]),
          readAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    const client = fakeClient(
      {},
      {
        readRange: async () => {
          throw new Error('network blip')
        },
      },
    )

    const result = await pullSheets(doc, client)

    expect(result.refreshed).toEqual([])
    expect(result.stale).toEqual([snapshotKey('sheet-1', 'Estimate!A1:B2')])

    const snapshot = getSnapshot(doc, 'sheet-1', 'Estimate!A1:B2')
    // The OLD numbers survive untouched — never silently replaced with nothing.
    expect(snapshot?.values).toEqual([['old', 'data']])
    expect(snapshot?.readAt).toBe('2026-01-01T00:00:00.000Z')
    expect(snapshot?.stale).toBe(true)
  })

  it('throws rather than writing an empty snapshot when there is no cache to fall back to', async () => {
    const { doc } = fixture()
    const client = fakeClient(
      {},
      {
        readRange: async () => {
          throw new Error('403 Forbidden')
        },
      },
    )

    await expect(pullSheets(doc, client)).rejects.toThrow('403 Forbidden')
    expect(existsSync(snapshotPathFor(doc))).toBe(false)
  })

  it('clears a stale flag once a later pull succeeds', async () => {
    const { doc } = fixture()
    saveSnapshotFile(doc, {
      version: 1,
      snapshots: {
        [snapshotKey('sheet-1', 'Estimate!A1:B2')]: {
          spreadsheetId: 'sheet-1',
          range: 'Estimate!A1:B2',
          values: [['old']],
          hash: hashRange([['old']]),
          readAt: '2026-01-01T00:00:00.000Z',
          stale: true,
        },
      },
    })

    const client = fakeClient({ 'sheet-1::Estimate!A1:B2': [['fresh']] })
    const result = await pullSheets(doc, client)

    expect(result.refreshed).toEqual([snapshotKey('sheet-1', 'Estimate!A1:B2')])
    const snapshot = getSnapshot(doc, 'sheet-1', 'Estimate!A1:B2')
    expect(snapshot?.stale).toBeUndefined()
    expect(snapshot?.values).toEqual([['fresh']])
  })
})

describe('pushSheets', () => {
  it('refuses to push when no snapshot has ever been pulled', async () => {
    const { doc } = fixture()
    const client = fakeClient()
    await expect(pushSheets(doc, client)).rejects.toThrow(/contrail sheet pull/)
  })

  it('pushes the cached values, guarded by the hash recorded at the last pull', async () => {
    const { doc } = fixture()
    const client = fakeClient({ 'sheet-1::Estimate!A1:B2': [['a', 'b']] })
    await pullSheets(doc, client)

    // Simulate an agent hand-editing the cached snapshot's numbers before pushing.
    const file = loadSnapshotFile(doc)
    const key = snapshotKey('sheet-1', 'Estimate!A1:B2')
    file.snapshots[key]!.values = [['a', 'edited']]
    saveSnapshotFile(doc, file)

    const result = await pushSheets(doc, client)

    expect(result.pushed).toEqual([key])
    expect(result.blocked).toEqual([])
    expect(await client.readRange('sheet-1', 'Estimate!A1:B2')).toEqual([['a', 'edited']])

    const after = getSnapshot(doc, 'sheet-1', 'Estimate!A1:B2')
    expect(after?.hash).toBe(hashRange([['a', 'edited']]))
  })

  it('is blocked by the write guard when the sheet was edited since the last pull, and leaves the sheet untouched', async () => {
    const { doc } = fixture()
    const client = fakeClient({ 'sheet-1::Estimate!A1:B2': [['a', 'b']] })
    await pullSheets(doc, client)

    // A human edits the live Sheet directly, out from under contrail.
    await client.writeRange('sheet-1', 'Estimate!A1:B2', [['human', 'edit']], {
      ifHash: hashRange([['a', 'b']]),
    })

    const result = await pushSheets(doc, client)

    expect(result.blocked).toEqual([snapshotKey('sheet-1', 'Estimate!A1:B2')])
    expect(result.pushed).toEqual([])
    expect(await client.readRange('sheet-1', 'Estimate!A1:B2')).toEqual([['human', 'edit']])
  })

  it('force overrides the guard and overwrites the human edit', async () => {
    const { doc } = fixture()
    const client = fakeClient({ 'sheet-1::Estimate!A1:B2': [['a', 'b']] })
    await pullSheets(doc, client)
    await client.writeRange('sheet-1', 'Estimate!A1:B2', [['human', 'edit']], { ifHash: hashRange([['a', 'b']]) })

    const result = await pushSheets(doc, client, { force: true })

    expect(result.pushed).toEqual([snapshotKey('sheet-1', 'Estimate!A1:B2')])
    expect(await client.readRange('sheet-1', 'Estimate!A1:B2')).toEqual([['a', 'b']])
  })

  it('handles multiple sheet blocks in one document independently', async () => {
    const twoBlocks = `---
title: T
summary: S
status: current
---

\`\`\`sheet {id=sheet-1, range="A!A1:A1", summary="First."}
\`\`\`

\`\`\`sheet {id=sheet-2, range="B!A1:A1", summary="Second."}
\`\`\`
`
    const { doc } = fixture(twoBlocks)
    const client = fakeClient({ 'sheet-1::A!A1:A1': [['1']], 'sheet-2::B!A1:A1': [['2']] })
    await pullSheets(doc, client)

    const raw = JSON.parse(readFileSync(snapshotPathFor(doc), 'utf8'))
    expect(Object.keys(raw.snapshots).sort()).toEqual(['sheet-1::A!A1:A1', 'sheet-2::B!A1:A1'])
  })
})
