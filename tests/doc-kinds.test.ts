import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOC_KINDS, sectionMismatch } from '../src/doc-kinds.js'
import { DocError, parseDoc } from '../src/parse.js'

function docFile(contents: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'contrail-dockind-'))
  const path = join(root, 'doc.md')
  writeFileSync(path, contents)
  return { root, path }
}

const BASE = '---\ntitle: T\nsummary: S\nstatus: current\n'

describe('audience', () => {
  it('defaults to internal when absent — the safety property', () => {
    const { root, path } = docFile(`${BASE}---\nBody.\n`)
    const doc = parseDoc(path, root)
    expect(doc.frontmatter.audience).toBe('internal')
  })

  it('rejects an invalid audience value', () => {
    const { root, path } = docFile(`${BASE}audience: everyone\n---\nBody.\n`)
    expect(() => parseDoc(path, root)).toThrow(DocError)
    expect(() => parseDoc(path, root)).toThrow(/audience/)
  })

  it('accepts an explicit client audience (opt-in)', () => {
    const { root, path } = docFile(`${BASE}audience: client\n---\nBody.\n`)
    expect(parseDoc(path, root).frontmatter.audience).toBe('client')
  })
})

describe('docKind', () => {
  it('rejects an unknown docKind, naming the valid set', () => {
    const { root, path } = docFile(`${BASE}docKind: made-up-kind\n---\nBody.\n`)
    expect(() => parseDoc(path, root)).toThrow(DocError)
    expect(() => parseDoc(path, root)).toThrow(/charter/)
  })

  it('accepts every documented docKind', () => {
    for (const kind of DOC_KINDS) {
      const { root, path } = docFile(`${BASE}docKind: ${kind}\n---\nBody.\n`)
      expect(parseDoc(path, root).frontmatter.docKind).toBe(kind)
    }
  })
})

describe('section', () => {
  it('rejects an unknown section', () => {
    const { root, path } = docFile(`${BASE}section: 99-nowhere\n---\nBody.\n`)
    expect(() => parseDoc(path, root)).toThrow(/section/)
  })

  it('does not fight a docKind whose section disagrees with its conventional home', () => {
    // prd conventionally lives in 04-technical, but a project reorganised it.
    // parseDoc must not throw for this — that is a warning, not an error.
    const { root, path } = docFile(`${BASE}docKind: prd\nsection: 02-planning\n---\nBody.\n`)
    expect(() => parseDoc(path, root)).not.toThrow()
  })
})

describe('sectionMismatch', () => {
  it('is silent when section matches the docKind\'s conventional home', () => {
    expect(sectionMismatch('prd', '04-technical')).toBeUndefined()
  })

  it('warns, without throwing, when section disagrees', () => {
    const message = sectionMismatch('prd', '02-planning')
    expect(message).toBeDefined()
    expect(message).toMatch(/prd/)
    expect(message).toMatch(/02-planning/)
    expect(message).toMatch(/04-technical/)
  })

  it('is silent when no section is set', () => {
    expect(sectionMismatch('prd', undefined)).toBeUndefined()
  })
})
