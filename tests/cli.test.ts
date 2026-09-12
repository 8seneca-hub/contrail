import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exitCodeFor, findDocs, runInit } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { parseDoc } from '../src/parse.js'
import type { PublishResult } from '../src/plane/publish.js'

describe('runInit', () => {
  it('writes a config file that loads cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-init-'))
    const path = runInit(root)
    expect(existsSync(path)).toBe(true)
    expect(loadConfig(path).plane.workspace).toBeTypeOf('string')
  })

  it('refuses to overwrite an existing config', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-init-'))
    runInit(root)
    expect(() => runInit(root)).toThrow(/already exists/)
  })
})

describe('findDocs', () => {
  it('finds documents across several repositories in one workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-find-'))
    mkdirSync(join(root, 'repo-a', 'docs'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'repo-a', 'docs', 'one.md'), '# one')
    writeFileSync(join(root, 'docs', 'two.md'), '# two')

    const found = findDocs({
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md', './*/docs/**/*.md'],
    })

    expect(found.map((path) => path.split('/').pop()).sort()).toEqual(['one.md', 'two.md'])
  })

  it('returns absolute paths, sorted deterministically', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-find-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'zeta.md'), '# zeta')
    writeFileSync(join(root, 'docs', 'alpha.md'), '# alpha')

    const found = findDocs({
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
    })

    expect(found.every((path) => path.startsWith(root))).toBe(true)
    expect(found).toEqual([...found].sort())
    expect(found.map((path) => path.split('/').pop())).toEqual(['alpha.md', 'zeta.md'])
  })

  it('returns an empty array when a glob matches nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-find-'))
    mkdirSync(join(root, 'docs'), { recursive: true })

    const found = findDocs({
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md', './nonexistent/**/*.md'],
    })

    expect(found).toEqual([])
  })
})

describe('--only filter', () => {
  it('selects the expected subset of documents by key substring', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-only-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'auth.md'),
      '---\ntitle: Auth\nsummary: Auth docs\nstatus: current\n---\n# Auth',
    )
    writeFileSync(
      join(root, 'docs', 'billing.md'),
      '---\ntitle: Billing\nsummary: Billing docs\nstatus: current\n---\n# Billing',
    )

    const config = {
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
    }
    const only = 'auth'
    const docs = findDocs(config)
      .map((path) => parseDoc(path, config.root))
      .filter((doc) => !only || doc.key.includes(only))

    expect(docs.map((doc) => doc.key)).toEqual(['docs/auth.md'])
  })
})

describe('exitCodeFor', () => {
  const base: PublishResult = { created: [], updated: [], skipped: [], blocked: [], archived: [] }

  it('is zero when nothing was blocked', () => {
    expect(exitCodeFor({ ...base, created: ['docs/a.md'] })).toBe(0)
  })

  it('is non-zero when anything was blocked', () => {
    expect(exitCodeFor({ ...base, blocked: ['docs/a.md'] })).toBe(1)
  })
})
