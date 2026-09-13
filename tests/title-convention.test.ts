import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDocs } from '../src/check.js'
import { cardinalityOf, COLLECTION_META, discriminatorPresent, DOC_KINDS } from '../src/doc-kinds.js'
import { parseDoc } from '../src/parse.js'
import { renderDocFile } from '../src/scaffold.js'

function docFile(root: string, contents: string): { root: string; path: string } {
  const path = join(root, 'doc.md')
  writeFileSync(path, contents)
  return { root, path }
}

const FM = (docKind: string, title: string) =>
  `---\ntitle: ${JSON.stringify(title)}\nsummary: S\nstatus: current\ndocKind: ${docKind}\n---\n\nBody.\n`

describe('Task 7: collection vs. singleton docKinds', () => {
  it('every collection docKind in COLLECTION_META reports cardinality "collection"', () => {
    for (const docKind of Object.keys(COLLECTION_META)) {
      expect(cardinalityOf(docKind as never)).toBe('collection')
    }
  })

  it('every docKind NOT in COLLECTION_META reports cardinality "singleton"', () => {
    const collectionKinds = new Set(Object.keys(COLLECTION_META))
    const singletons = DOC_KINDS.filter((k) => !collectionKinds.has(k))
    expect(singletons.length).toBeGreaterThan(0)
    for (const docKind of singletons) {
      expect(cardinalityOf(docKind)).toBe('singleton')
    }
  })
})

describe('Task 7: `discriminatorPresent` detects each discriminator shape', () => {
  it('date: a spelled-out date is present, an ISO date or no date is not', () => {
    expect(discriminatorPresent('date', 'Kickoff call — 11 August 2026')).toBe(true)
    expect(discriminatorPresent('date', 'Kickoff call — 2026-08-11')).toBe(false)
    expect(discriminatorPresent('date', 'Kickoff')).toBe(false)
  })

  it('number: any digit counts, prose without one does not', () => {
    expect(discriminatorPresent('number', 'ADR 0001 — The TMS stays the system of record')).toBe(true)
    expect(discriminatorPresent('number', 'CR 003 — Add mobile app (rejected)')).toBe(true)
    expect(discriminatorPresent('number', 'TMS decision')).toBe(false)
  })

  it('version: a v-prefixed or bare dotted version is present, prose is not', () => {
    expect(discriminatorPresent('version', 'v1.2.0 — 20 September 2026')).toBe(true)
    expect(discriminatorPresent('version', '1.2.0 — 20 September 2026')).toBe(true)
    expect(discriminatorPresent('version', 'The big release')).toBe(false)
  })
})

describe('Task 7: `title-missing-discriminator` lint rule', () => {
  it('warns for each collection docKind whose title lacks its discriminator', () => {
    const cases: Array<[string, string]> = [
      ['meeting', 'Kickoff'],
      ['adr', 'TMS decision'],
      ['change-request', 'Add mobile app'],
      ['qa-report', 'UAT cycle 2'],
      ['release', 'The big release'],
    ]
    for (const [docKind, title] of cases) {
      const root = mkdtempSync(join(tmpdir(), 'contrail-title-warn-'))
      const { path } = docFile(root, FM(docKind, title))
      const doc = parseDoc(path, root)
      const findings = checkDocs([doc]).filter((f) => f.rule === 'title-missing-discriminator')
      expect(findings, `expected a warning for docKind '${docKind}' with title "${title}"`).toHaveLength(1)
      expect(findings[0]!.severity).toBe('warn')
      expect(findings[0]!.message).toContain(title)
      expect(findings[0]!.message).toContain('Expected:')
    }
  })

  it('does not warn when a collection docKind title already follows its convention', () => {
    const cases: Array<[string, string]> = [
      ['meeting', 'Kickoff call — 11 August 2026'],
      ['adr', 'ADR 0001 — The TMS stays the system of record'],
      ['change-request', 'CR 003 — Add mobile app (rejected)'],
      ['qa-report', 'UAT cycle 2 — 14 September 2026'],
      ['release', 'v1.2.0 — 20 September 2026'],
    ]
    for (const [docKind, title] of cases) {
      const root = mkdtempSync(join(tmpdir(), 'contrail-title-ok-'))
      const { path } = docFile(root, FM(docKind, title))
      const doc = parseDoc(path, root)
      const findings = checkDocs([doc]).filter((f) => f.rule === 'title-missing-discriminator')
      expect(findings, `expected no warning for docKind '${docKind}' with title "${title}"`).toHaveLength(0)
    }
  })

  it('never warns for a singleton docKind, regardless of its title', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-title-singleton-'))
    const { path } = docFile(root, FM('budget', 'Budget'))
    const doc = parseDoc(path, root)
    expect(checkDocs([doc]).filter((f) => f.rule === 'title-missing-discriminator')).toHaveLength(0)
  })

  it('never warns for a document with no docKind at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-title-nokind-'))
    const { path } = docFile(root, '---\ntitle: "Just a doc"\nsummary: S\nstatus: current\n---\n\nBody.\n')
    const doc = parseDoc(path, root)
    expect(checkDocs([doc]).filter((f) => f.rule === 'title-missing-discriminator')).toHaveLength(0)
  })
})

describe('Task 7: scaffold derives the title from the filename', () => {
  it('a date-named meeting filename produces "<Purpose> — <D Month YYYY>"', () => {
    const rendered = renderDocFile('meeting', '/tmp/x/docs/03-management/meetings/2026-09-13-sprint-review.md')
    expect(rendered).toContain('title: "Sprint review — 13 September 2026"')
    expect(rendered).toContain('# Sprint review — 13 September 2026')
  })

  it('a numbered ADR filename produces "ADR <NNNN> — <decision>"', () => {
    const rendered = renderDocFile('adr', '/tmp/x/docs/03-management/decisions/0007-use-postgres.md')
    expect(rendered).toContain('title: "ADR 0007 — Use postgres"')
  })

  it('a filename that does not carry the discriminator falls back to the fixed docKind title', () => {
    const rendered = renderDocFile('meeting', '/tmp/x/docs/03-management/meetings/notes.md')
    expect(rendered).toContain('title: "Meeting Notes"')
  })

  it('a singleton docKind ignores the filename entirely and keeps its fixed title', () => {
    const rendered = renderDocFile('budget', '/tmp/x/docs/03-management/2026-09-13-not-a-budget-date.md')
    expect(rendered).toContain('title: "Budget"')
  })

  it('without a target path at all (runInitTemplate\'s usage), the fixed title is used', () => {
    const rendered = renderDocFile('charter')
    expect(rendered).toContain('title: "Project Charter"')
  })
})
