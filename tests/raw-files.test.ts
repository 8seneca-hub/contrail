import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectRawFiles, rawFileHref, type RawFile } from '../src/raw-files.js'

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'contrail-raw-'))
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

describe('collectRawFiles', () => {
  it('collects the raw material a `files` glob names, content-addressed', () => {
    const root = workspace({ 'raw/estimate.xlsx': 'pretend spreadsheet bytes' })
    const found = collectRawFiles(root, ['./raw/**/*'])

    expect(found).toHaveLength(1)
    expect(found[0]?.sourceRel).toBe('raw/estimate.xlsx')
    // Content-addressed like diagrams and assets, so identical bytes are stored
    // once and changed bytes get a new URL instead of a stale cached one.
    expect(found[0]?.outPath).toMatch(/^files\/[a-f0-9]{16}\.xlsx$/)
    expect(found[0]?.size).toBeGreaterThan(0)
  })

  it('gives identical bytes the same path and different bytes a different one', () => {
    const root = workspace({
      'raw/a.xlsx': 'same bytes',
      'raw/b.xlsx': 'same bytes',
      'raw/c.xlsx': 'other bytes',
    })
    const byName = new Map(collectRawFiles(root, ['./raw/**/*']).map((f) => [f.sourceRel, f.outPath]))
    expect(byName.get('raw/a.xlsx')).toBe(byName.get('raw/b.xlsx'))
    expect(byName.get('raw/c.xlsx')).not.toBe(byName.get('raw/a.xlsx'))
  })

  it('never collects markdown — a document is a document, not an attachment', () => {
    const root = workspace({ 'raw/notes.md': '# notes', 'raw/estimate.xlsx': 'x' })
    expect(collectRawFiles(root, ['./raw/**/*']).map((f) => f.sourceRel)).toEqual(['raw/estimate.xlsx'])
  })

  it('returns nothing when no `files` glob is configured', () => {
    const root = workspace({ 'raw/estimate.xlsx': 'x' })
    expect(collectRawFiles(root, undefined)).toEqual([])
  })
})

describe('rawFileHref', () => {
  const file: RawFile = {
    sourceRel: 'raw/estimate.xlsx',
    absPath: '/tmp/raw/estimate.xlsx',
    outPath: 'files/0123456789abcdef.xlsx',
    size: 34082,
  }

  it('resolves against the page, so a nested document links correctly', () => {
    // `rootPrefix` is what `rootPrefixFor` produces: the steps BACK to the site
    // root, not the page's own directory.
    expect(rawFileHref(file, '../')).toBe('../files/0123456789abcdef.xlsx')
    expect(rawFileHref(file, '../../')).toBe('../../files/0123456789abcdef.xlsx')
    expect(rawFileHref(file, '')).toBe('files/0123456789abcdef.xlsx')
  })
})
