import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocError, parseDoc } from '../src/parse.js'

function docFile(contents: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'contrail-doc-'))
  const path = join(root, 'flow.md')
  writeFileSync(path, contents)
  return { root, path }
}

const VALID = `---
title: Settlement flow
summary: How settlement moves between services.
status: current
tags: [settlement]
---

# Heading

Body text.
`

describe('unanswered', () => {
  const stub = (unanswered: string) => `---
title: Business Case
summary: Why this project is worth doing, in business terms.
status: draft
docKind: business-case
unanswered: ${unanswered}
---

# Business Case

## Guiding questions

- What is the expected benefit, weighed against the cost?
`

  it('carries a reason string through onto the parsed document', () => {
    const { root, path } = docFile(stub('"No cost or approver stated in the source brief."'))
    expect(parseDoc(path, root).frontmatter.unanswered).toBe('No cost or approver stated in the source brief.')
  })

  it('rejects an empty reason — the point of the field is the reason', () => {
    const { root, path } = docFile(stub('""'))
    expect(() => parseDoc(path, root)).toThrow(/flow\.md.*unanswered.*non-empty/)
  })

  it('rejects a bare `true`, which records no reason at all', () => {
    const { root, path } = docFile(stub('true'))
    expect(() => parseDoc(path, root)).toThrow(/flow\.md.*unanswered.*string/)
  })

  it('is absent, not empty, on a document that does not use it', () => {
    const { root, path } = docFile(VALID)
    expect(parseDoc(path, root).frontmatter.unanswered).toBeUndefined()
  })
})

describe('parseDoc', () => {
  it('parses frontmatter and body into a Doc', () => {
    const { root, path } = docFile(VALID)
    const doc = parseDoc(path, root)
    expect(doc.frontmatter.title).toBe('Settlement flow')
    expect(doc.frontmatter.status).toBe('current')
    expect(doc.key).toBe('flow.md')
    expect(doc.tree.children.length).toBeGreaterThan(0)
  })

  it('rejects a document with no title, naming the file', () => {
    const { root, path } = docFile('---\nsummary: s\nstatus: current\n---\nbody\n')
    expect(() => parseDoc(path, root)).toThrow(/flow\.md.*title/)
  })

  it('rejects a document with no summary', () => {
    const { root, path } = docFile('---\ntitle: t\nstatus: current\n---\nbody\n')
    expect(() => parseDoc(path, root)).toThrow(DocError)
  })

  it('rejects an unknown status value', () => {
    const { root, path } = docFile('---\ntitle: t\nsummary: s\nstatus: published\n---\nbody\n')
    expect(() => parseDoc(path, root)).toThrow(/status/)
  })

  it('normalizes an unquoted YAML `reviewedOn` date back to a plain ISO string', () => {
    // js-yaml auto-parses an unquoted date like `2026-09-01` into a real Date
    // object, not the string the Frontmatter schema promises. `unreviewed`
    // (check.ts) depends on this being a string it can display and re-parse.
    const { root, path } = docFile('---\ntitle: t\nsummary: s\nstatus: current\nreviewedOn: 2026-09-01\n---\nbody\n')
    const doc = parseDoc(path, root)
    expect(doc.frontmatter.reviewedOn).toBe('2026-09-01')
    expect(typeof doc.frontmatter.reviewedOn).toBe('string')
  })

  it('leaves an explicitly-quoted `reviewedOn` string untouched', () => {
    const { root, path } = docFile('---\ntitle: t\nsummary: s\nstatus: current\nreviewedOn: "2026-09-01"\n---\nbody\n')
    expect(parseDoc(path, root).frontmatter.reviewedOn).toBe('2026-09-01')
  })
})
