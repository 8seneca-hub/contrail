import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSite } from '../src/emit/site.js'
import { emitMarkdown } from '../src/emit/md.js'
import { parseDoc } from '../src/parse.js'
import { saveSnapshotFile, snapshotKey } from '../src/sheets/snapshot.js'
import type { Doc } from '../src/types.js'

const DOC = `---
title: Estimate
summary: S
status: current
---

\`\`\`sheet {id=sheet-1, range="Estimate!A1:B2", summary="Effort estimate by workstream."}
\`\`\`
`

function fixture(body: string = DOC): { root: string; doc: Doc } {
  const root = mkdtempSync(join(tmpdir(), 'contrail-emit-sheet-'))
  writeFileSync(join(root, 'doc.md'), body)
  return { root, doc: parseDoc(join(root, 'doc.md'), root) }
}

function seedSnapshot(
  doc: Doc,
  values: string[][],
  opts: { stale?: boolean; readAt?: string; id?: string; range?: string } = {},
) {
  const id = opts.id ?? 'sheet-1'
  const range = opts.range ?? 'Estimate!A1:B2'
  saveSnapshotFile(doc, {
    version: 1,
    snapshots: {
      [snapshotKey(id, range)]: {
        spreadsheetId: id,
        range,
        values,
        hash: 'irrelevant-for-render',
        readAt: opts.readAt ?? '2026-03-01T12:00:00.000Z',
        stale: opts.stale,
      },
    },
  })
}

describe('site emitter — sheet block', () => {
  it('renders the range as a table, plus a link to the Sheet and the read timestamp', async () => {
    const { root, doc } = fixture()
    seedSnapshot(doc, [
      ['Workstream', 'Days'],
      ['Design', '12'],
    ])

    const result = await buildSite({ docs: [doc], outDir: join(root, 'out'), cacheDir: join(root, '.cache') })
    expect(result.pages).toEqual(['doc.md'])
    const page = readFileSync(join(root, 'out', 'doc.html'), 'utf8')

    expect(page).toContain('<table')
    expect(page).toContain('<td>Workstream</td>')
    expect(page).toContain('<td>Design</td>')
    expect(page).toContain('<td>12</td>')
    expect(page).toContain('https://docs.google.com/spreadsheets/d/sheet-1/edit')
    expect(page).toContain('2026-03-01T12:00:00.000Z')
    expect(page).toContain('Effort estimate by workstream.')
  })

  it('throws with an actionable message when no snapshot exists yet', async () => {
    const { root, doc } = fixture()
    await expect(
      buildSite({ docs: [doc], outDir: join(root, 'out'), cacheDir: join(root, '.cache') }),
    ).rejects.toThrow(/contrail sheet pull/)
  })

  it('renders a well-formed table for ragged rows', async () => {
    const { root, doc } = fixture()
    seedSnapshot(doc, [['a', 'b', 'c'], ['1'], ['x', 'y']])

    const result = await buildSite({ docs: [doc], outDir: join(root, 'out'), cacheDir: join(root, '.cache') })
    const page = readFileSync(join(root, 'out', 'doc.html'), 'utf8')

    // Every <tr> has the same number of <td>s: padded to the widest row (3).
    const rows = [...page.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1]!)
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect((row.match(/<td>/g) ?? [])).toHaveLength(3)
    }
    expect(result.pages).toEqual(['doc.md'])
  })

  it('renders a visible staleness note with the cached timestamp when the snapshot is marked stale', async () => {
    const { root, doc } = fixture()
    seedSnapshot(doc, [['old', 'data']], { stale: true, readAt: '2025-12-25T00:00:00.000Z' })

    await buildSite({ docs: [doc], outDir: join(root, 'out'), cacheDir: join(root, '.cache') })
    const page = readFileSync(join(root, 'out', 'doc.html'), 'utf8')

    expect(page).toMatch(/STALE/)
    expect(page).toContain('2025-12-25T00:00:00.000Z')
    expect(page).toContain('<td>old</td>')
  })
})

describe('md emitter — sheet block', () => {
  it('renders the range as a Markdown table, with no link an agent cannot follow', () => {
    const { doc } = fixture()
    seedSnapshot(doc, [
      ['Workstream', 'Days'],
      ['Design', '12'],
    ])

    const out = emitMarkdown(doc)

    expect(out).toContain('| Workstream | Days |')
    expect(out).toContain('| Design')
    expect(out).toContain('12')
    expect(out).toContain('Effort estimate by workstream.')
    expect(out).not.toContain('docs.google.com')
    expect(out).not.toContain('```sheet')
  })

  it('throws with an actionable message when no snapshot exists yet', () => {
    const { doc } = fixture()
    expect(() => emitMarkdown(doc)).toThrow(/contrail sheet pull/)
  })

  it('renders a visible staleness note in the Markdown when the snapshot is stale', () => {
    const { doc } = fixture()
    seedSnapshot(doc, [['old', 'data']], { stale: true, readAt: '2025-12-25T00:00:00.000Z' })

    const out = emitMarkdown(doc)
    expect(out).toMatch(/STALE/)
    expect(out).toContain('2025-12-25T00:00:00.000Z')
  })

  it('renders a well-formed table for ragged rows (consistent column count)', () => {
    const { doc } = fixture()
    seedSnapshot(doc, [['a', 'b', 'c'], ['1'], ['x', 'y']])

    const out = emitMarkdown(doc)
    const tableLines = out.split('\n').filter((line) => line.trimStart().startsWith('|'))
    expect(tableLines.length).toBeGreaterThanOrEqual(3)
    const columnCounts = new Set(tableLines.map((line) => line.split('|').length))
    expect(columnCounts.size).toBe(1) // every row has the same number of pipe-separated cells
  })
})
