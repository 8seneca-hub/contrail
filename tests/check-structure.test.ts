import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globSync } from 'tinyglobby'
import { describe, expect, it } from 'vitest'
import { checkDocs, docStatusReport, isStub, pathSection } from '../src/check.js'
import { parseDoc } from '../src/parse.js'
import { renderDocFile, runInitTemplate } from '../src/scaffold.js'
import type { Doc } from '../src/types.js'

function writeDocAt(relPath: string, contents: string, root = mkdtempSync(join(tmpdir(), 'contrail-structure-'))): Doc {
  const abs = join(root, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, contents)
  return parseDoc(abs, root)
}

function findingsFor(rule: string, docs: Doc[]) {
  return checkDocs(docs).filter((f) => f.rule === rule)
}

const FM = (extra = '') => `---\ntitle: T\nsummary: S\nstatus: current\n${extra}---\n\n`

describe('isStub', () => {
  it('recognizes the exact shape renderDocFile emits: heading(s) + bullet list, no paragraph', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-isstub-'))
    const path = join(root, 'charter.md')
    writeFileSync(path, renderDocFile('charter'))
    expect(isStub(parseDoc(path, root))).toBe(true)
  })

  it('stops recognizing a document as a stub the instant it gets a real paragraph', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-isstub-'))
    const path = join(root, 'charter.md')
    writeFileSync(path, `${renderDocFile('charter')}\nThe client sponsors this to replace their ticketing system.\n`)
    expect(isStub(parseDoc(path, root))).toBe(false)
  })

  it('is not fooled by an ordered list of real steps (steps-without-diagram territory, not a stub)', () => {
    const d = writeDocAt('doc.md', `${FM()}1. First\n2. Second\n3. Third\n4. Fourth\n`)
    expect(isStub(d)).toBe(false)
  })
})

describe('Ruling 1: content rules skip a document still in stub state', () => {
  it('flow-without-diagram does NOT fire on the scaffolded architecture.md stub (the exact reported flaw)', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-stub-skip-'))
    const path = join(root, 'architecture.md')
    writeFileSync(path, renderDocFile('architecture'))
    const d = parseDoc(path, root)
    expect(isStub(d)).toBe(true)
    expect(findingsFor('flow-without-diagram', [d])).toHaveLength(0)
  })

  it('the same heading DOES fire once real flow prose replaces the stub content', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-stub-skip-'))
    const path = join(root, 'architecture.md')
    writeFileSync(
      path,
      `${FM()}# System Overview\n\n## Request flow\n\nThe request moves through the gateway, the service, and the queue, in that order.\n`,
    )
    const d = parseDoc(path, root)
    expect(isStub(d)).toBe(false)
    expect(findingsFor('flow-without-diagram', [d])).toHaveLength(1)
  })

  it('a fresh `init --template agency-project` tree reports ZERO findings end to end', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-fresh-scaffold-'))
    runInitTemplate(root, { client: 'Acme', project: 'Demo', startDate: '2026-09-12' })

    const paths = globSync(['./docs/**/*.md'], { cwd: root, absolute: true }).sort()
    const docs = paths.map((p: string) => parseDoc(p, root))

    expect(docs.length).toBeGreaterThanOrEqual(30)
    expect(checkDocs(docs)).toEqual([])
  })
})

describe('empty-stub', () => {
  it('stays silent while a stub is still `status: draft` — a fresh scaffold must not double as a warning', () => {
    const d = writeDocAt('architecture.md', renderDocFile('architecture'))
    expect(findingsFor('empty-stub', [d])).toHaveLength(0)
  })

  it('fires once the stub is promoted past draft with no content added', () => {
    const stub = renderDocFile('architecture').replace('status: draft', 'status: current')
    const d = writeDocAt('architecture.md', stub)
    const findings = findingsFor('empty-stub', [d])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warn')
    expect(findings[0]!.message).toContain('status: current')
  })

  it('stays silent once real content is added, regardless of status', () => {
    const filled = renderDocFile('architecture').replace('status: draft', 'status: current') + '\nThe system has three services.\n'
    const d = writeDocAt('architecture.md', filled)
    expect(findingsFor('empty-stub', [d])).toHaveLength(0)
  })
})

describe('orphan-doc', () => {
  it('fires when a document is nested in a folder that names none of the six sections', () => {
    const d = writeDocAt('06-random/notes.md', `${FM()}Some stray notes.\n`)
    expect(findingsFor('orphan-doc', [d])).toHaveLength(1)
  })

  it('stays silent when the document lives under a recognized section, even nested deeper', () => {
    const d = writeDocAt('01-overview/intake/README.md', `${FM()}Intake notes.\n`)
    expect(findingsFor('orphan-doc', [d])).toHaveLength(0)
  })

  it('stays silent on a bare filename with no folder to judge placement', () => {
    const d = writeDocAt('notes.md', `${FM()}Some notes.\n`)
    expect(findingsFor('orphan-doc', [d])).toHaveLength(0)
  })
})

describe('missing-core-doc', () => {
  it('fires when a section has documents but is missing one of its core docKinds', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-core-'))
    const docs = [
      writeDocAt('02-planning/scope-statement.md', `${FM('docKind: scope\n')}Scope.\n`, root),
      writeDocAt('02-planning/wbs.md', `${FM('docKind: wbs\n')}WBS.\n`, root),
      // schedule, estimate, assumptions are all missing for 02-planning.
    ]
    const findings = findingsFor('missing-core-doc', docs)
    const kinds = findings.map((f) => f.message)
    expect(findings.length).toBe(3)
    expect(kinds.some((m) => m.includes("'schedule'"))).toBe(true)
    expect(kinds.some((m) => m.includes("'estimate'"))).toBe(true)
    expect(kinds.some((m) => m.includes("'assumptions'"))).toBe(true)
    expect(findings[0]!.doc).toBe('02-planning')
  })

  it('stays silent for a section nothing lives in yet — absence of a section is not a missing document', () => {
    const d = writeDocAt('02-planning/scope-statement.md', `${FM('docKind: scope\n')}Scope.\n`)
    // Only 02-planning exists in this corpus; 04-technical is simply absent, not incomplete.
    expect(findingsFor('missing-core-doc', [d]).some((f) => f.doc === '04-technical')).toBe(false)
  })

  it('stays silent when every core docKind for a present section is accounted for', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-core-full-'))
    const docs = [
      writeDocAt('02-planning/scope-statement.md', `${FM('docKind: scope\n')}S.\n`, root),
      writeDocAt('02-planning/wbs.md', `${FM('docKind: wbs\n')}S.\n`, root),
      writeDocAt('02-planning/schedule.md', `${FM('docKind: schedule\n')}S.\n`, root),
      writeDocAt('02-planning/estimate.md', `${FM('docKind: estimate\n')}S.\n`, root),
      writeDocAt('02-planning/assumptions.md', `${FM('docKind: assumptions\n')}S.\n`, root),
    ]
    expect(findingsFor('missing-core-doc', docs)).toHaveLength(0)
  })
})

describe('no-owner', () => {
  it('stays silent on an untouched draft — nobody has claimed it yet, and that is fine', () => {
    const d = writeDocAt('doc.md', `---\ntitle: T\nsummary: S\nstatus: draft\n---\n\nSome draft prose.\n`)
    expect(findingsFor('no-owner', [d])).toHaveLength(0)
  })

  it('fires once a document is past draft with no owner', () => {
    const d = writeDocAt('doc.md', `${FM()}Some prose.\n`)
    const findings = findingsFor('no-owner', [d])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warn')
  })

  it('stays silent once an owner is set', () => {
    const d = writeDocAt('doc.md', `${FM('owner: alice\n')}Some prose.\n`)
    expect(findingsFor('no-owner', [d])).toHaveLength(0)
  })
})

describe('unreviewed', () => {
  it('fires on a `current` document with no `reviewedOn` at all', () => {
    const d = writeDocAt('doc.md', `${FM()}Some prose.\n`)
    expect(findingsFor('unreviewed', [d])).toHaveLength(1)
  })

  it('stays silent on a non-current document with no `reviewedOn`', () => {
    const d = writeDocAt('doc.md', `---\ntitle: T\nsummary: S\nstatus: draft\n---\n\nSome draft prose.\n`)
    expect(findingsFor('unreviewed', [d])).toHaveLength(0)
  })

  it('fires when `reviewedOn` is more than 90 days old, regardless of status', () => {
    const d = writeDocAt('doc.md', `${FM('reviewedOn: 2020-01-01\n')}Some prose.\n`)
    const findings = findingsFor('unreviewed', [d])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('2020-01-01')
  })

  it('stays silent when `reviewedOn` is recent', () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const d = writeDocAt('doc.md', `${FM(`reviewedOn: ${recent}\n`)}Some prose.\n`)
    expect(findingsFor('unreviewed', [d])).toHaveLength(0)
  })
})

describe('pathSection', () => {
  it('reads the section from any path segment, not just the first', () => {
    expect(pathSection('docs/01-overview/intake/README.md')).toBe('01-overview')
    expect(pathSection('01-overview/README.md')).toBe('01-overview')
  })

  it('returns undefined for a path naming no section', () => {
    expect(pathSection('notes.md')).toBeUndefined()
    expect(pathSection('06-random/notes.md')).toBeUndefined()
  })
})

describe('docStatusReport — the documentation view behind `contrail status`', () => {
  it('answers the state of the documentation, never the state of the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-status-report-'))
    const docs = [
      writeDocAt('01-overview/charter.md', renderDocFile('charter'), root),
      writeDocAt('02-planning/scope-statement.md', `${FM('docKind: scope\n')}Scope is set.\n`, root),
    ]
    const report = docStatusReport(docs)

    expect(report.stubs).toEqual(['01-overview/charter.md'])
    expect(report.noOwner.sort()).toEqual(['01-overview/charter.md', '02-planning/scope-statement.md'])
    expect(report.missingCoreDocs.some((f) => f.doc === '02-planning')).toBe(true)
  })
})
