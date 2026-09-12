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
})
