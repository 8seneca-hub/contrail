import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unservableFiles } from '../src/deploy/plane-docs.js'

function buildDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'contrail-types-'))
  for (const rel of files) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, 'bytes')
  }
  return dir
}

describe('unservableFiles', () => {
  it('names a file the server will reject, rather than letting it fail the whole manifest', () => {
    // One disallowed type 400s the ENTIRE upload, not just its own entry — so a
    // single spreadsheet would take the whole publish down with it.
    const dir = buildDir(['index.html', 'files/abc123.xlsx'])
    expect(unservableFiles(dir)).toEqual(['files/abc123.xlsx'])
  })

  it('passes everything the docs endpoint actually serves', () => {
    const dir = buildDir([
      'index.html',
      'site.css',
      'llms.txt',
      '02-planning/estimate.md',
      'assets/a.png',
      'diagrams/b.html',
      'fonts/inter-latin-wght-normal.woff2',
    ])
    expect(unservableFiles(dir)).toEqual([])
  })

  it('names every offender, so one fix round clears them all', () => {
    const dir = buildDir(['files/a.xlsx', 'files/b.pdf', 'files/c.docx', 'index.html'])
    expect(unservableFiles(dir)).toEqual(['files/a.xlsx', 'files/b.pdf', 'files/c.docx'].sort())
  })
})
