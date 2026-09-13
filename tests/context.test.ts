import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contextEmptyMessage, contextQuery, TASK_DOC_KINDS, TASK_TYPES } from '../src/context.js'
import { parseDoc } from '../src/parse.js'
import type { Doc } from '../src/types.js'

function writeDocAt(root: string, relPath: string, contents: string): Doc {
  const abs = join(root, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, contents)
  return parseDoc(abs, root)
}

const FM = (docKind: string, extra = '') =>
  `---\ntitle: T\nsummary: S\nstatus: current\ndocKind: ${docKind}\n${extra}---\n\nBody.\n`

describe('contextQuery: task types return their documented docKinds in order', () => {
  for (const task of TASK_TYPES) {
    it(`'${task}' ranks its docKinds in the documented order`, () => {
      const root = mkdtempSync(join(tmpdir(), 'contrail-context-task-'))
      const kinds = TASK_DOC_KINDS[task]
      // Write one doc per docKind, in REVERSE order on disk, so a passing test proves the
      // ranking logic reordered them rather than merely preserving file-read order.
      const docs = [...kinds].reverse().map((kind, i) => writeDocAt(root, `doc-${i}.md`, FM(kind)))

      const results = contextQuery(docs, { task })
      expect(results.map((r) => r.docKind)).toEqual([...kinds])
      for (const r of results) {
        // The full ranking explanation ("adr ranks 1 of 2...") now lives once in `contextRule`,
        // not repeated per row — each row's machine-readable `reason` is just its short code.
        expect(r.reason).toContain(`docKind:${r.docKind}`)
      }
    })
  }

  it('a docKind not in the task list is excluded entirely', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-context-exclude-'))
    const wanted = writeDocAt(root, 'prd.md', FM('prd'))
    writeDocAt(root, 'budget.md', FM('budget'))
    const results = contextQuery([wanted], { task: 'feature' })
    expect(results.map((r) => r.path)).toEqual([wanted.key])
  })
})

describe('contextQuery: keyword-only queries (no --task)', () => {
  it('matches on title, summary, or tags, and excludes documents with no match', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-context-keyword-'))
    const pricing = writeDocAt(
      root,
      'pricing.md',
      '---\ntitle: Pricing model\nsummary: How we price the engagement\nstatus: current\n---\n\nBody.\n',
    )
    const allDocs = [
      pricing,
      writeDocAt(root, 'other.md', '---\ntitle: Onboarding\nsummary: How new hires ramp up\nstatus: current\n---\n\nBody.\n'),
    ]
    const matched = contextQuery(allDocs, { keywords: ['pricing'] })
    expect(matched.map((r) => r.path)).toEqual([pricing.key])
    expect(matched[0]!.reason).toContain('keyword:pricing')
    expect(matched[0]!.note).toContain('matched "pricing"')
  })
})

describe('contextQuery: a stale document ranks last and is labelled', () => {
  it('sinks a stale document below every non-stale document, even one with a lower task priority', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-context-stale-'))
    // 'prd' is priority 1 (highest) for 'feature'; mark it stale so a correct implementation
    // must still rank it below the lower-priority, non-stale 'adr'.
    const stalePrd = writeDocAt(
      root,
      'prd.md',
      '---\ntitle: T\nsummary: S\nstatus: stale\ndocKind: prd\n---\n\nBody.\n',
    )
    const adr = writeDocAt(root, 'adr.md', FM('adr'))

    const results = contextQuery([stalePrd, adr], { task: 'feature' })
    expect(results.map((r) => r.path)).toEqual([adr.key, stalePrd.key])
    expect(results[1]!.status).toBe('stale')
    expect(results[1]!.reason).toContain('stale')
    expect(results[1]!.note).toContain('may be the only record')
    // Never dropped, even though it ranked last:
    expect(results.map((r) => r.path)).toContain(stalePrd.key)
  })
})

describe('contextQuery: --audience client never returns an internal document', () => {
  it('excludes an internal document from a tree containing both audiences', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-context-audience-'))
    const clientDoc = writeDocAt(
      root,
      'client-facing.md',
      FM('scope', 'audience: client\n'),
    )
    const internalDoc = writeDocAt(root, 'internal-only.md', FM('scope', 'audience: internal\n'))

    const results = contextQuery([clientDoc, internalDoc], { task: 'scope', audience: 'client' })
    expect(results.map((r) => r.path)).toEqual([clientDoc.key])
    expect(results.map((r) => r.path)).not.toContain(internalDoc.key)
  })
})

describe('contextQuery: --limit truncates by rank', () => {
  it('keeps only the top N results, in rank order', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-context-limit-'))
    const docs = TASK_DOC_KINDS.feature.map((kind, i) => writeDocAt(root, `doc-${i}.md`, FM(kind)))

    const full = contextQuery(docs, { task: 'feature' })
    const limited = contextQuery(docs, { task: 'feature', limit: 2 })
    expect(limited).toHaveLength(2)
    expect(limited).toEqual(full.slice(0, 2))
  })
})

describe('contextQuery: an empty tree', () => {
  it('returns an empty result, and contextEmptyMessage says so rather than erroring', () => {
    const results = contextQuery([], { task: 'feature' })
    expect(results).toEqual([])
    expect(contextEmptyMessage({ task: 'feature' })).toMatch(/no documents matched/)
    expect(() => contextEmptyMessage({ task: 'feature' })).not.toThrow()
  })

  it('says so for a keyword query too', () => {
    expect(contextEmptyMessage({ keywords: ['nope'] })).toContain("'nope'")
  })
})

describe('contextQuery: recency tiebreak for collection docKinds', () => {
  it('ranks the highest-numbered ADR first when multiple ADRs tie on everything else', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-context-recency-'))
    const adr1 = writeDocAt(root, '03-management/decisions/0001-first.md', FM('adr'))
    const adr3 = writeDocAt(root, '03-management/decisions/0003-third.md', FM('adr'))
    const adr2 = writeDocAt(root, '03-management/decisions/0002-second.md', FM('adr'))

    const results = contextQuery([adr1, adr2, adr3], { task: 'decision' })
    expect(results.map((r) => r.path)).toEqual([adr3.key, adr2.key, adr1.key])
  })
})
