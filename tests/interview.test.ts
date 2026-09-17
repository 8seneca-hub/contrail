import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import { DOC_KINDS, type DocKind } from '../src/doc-kinds.js'
import {
  DOC_FILES,
  guidingQuestions,
  INTERVIEW_ROUNDS,
  interviewRounds,
  runInitTemplate,
} from '../src/scaffold.js'

describe('INTERVIEW_ROUNDS coverage', () => {
  it('assigns every scaffolded docKind to exactly one round', () => {
    const assigned = INTERVIEW_ROUNDS.flatMap((round) => round.docKinds)
    const duplicated = assigned.filter((kind, i) => assigned.indexOf(kind) !== i)
    expect(duplicated).toEqual([])

    // `open-questions` is the register of what the interview FAILED to settle,
    // so it is filled from the leftovers rather than asked about.
    const scaffolded = DOC_FILES.map((f) => f.docKind).filter((k) => k !== 'open-questions')
    expect([...assigned].sort()).toEqual([...scaffolded].sort())
  })

  it('never names a docKind that does not exist', () => {
    for (const round of INTERVIEW_ROUNDS) {
      for (const kind of round.docKinds) {
        expect(DOC_KINDS).toContain(kind as DocKind)
      }
    }
  })

  it('gives every round a theme a person would recognise as one conversation', () => {
    for (const round of INTERVIEW_ROUNDS) {
      expect(round.theme.length).toBeGreaterThan(3)
      expect(round.docKinds.length).toBeGreaterThan(0)
    }
  })
})

describe('interviewRounds', () => {
  function freshTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'contrail-interview-'))
    runInitTemplate(root, { client: 'Acme', project: 'Demo', startDate: '2026-09-16' })
    return root
  }

  it('asks every round on a fresh tree, each carrying its documents and their questions', () => {
    const rounds = interviewRounds(freshTree())
    expect(rounds).toHaveLength(INTERVIEW_ROUNDS.length)

    const first = rounds[0]!
    expect(first.number).toBe(1)
    expect(first.of).toBe(INTERVIEW_ROUNDS.length)
    expect(first.documents.length).toBeGreaterThan(0)
    expect(first.documents[0]?.questions).toEqual(guidingQuestions(first.documents[0]!.docKind))
  })

  it('drops a document once it has been answered, so a half-finished interview resumes', () => {
    const root = freshTree()
    const before = interviewRounds(root)
    const target = before[0]!.documents[0]!

    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    appendFileSync(join(root, target.key), '\nThe sponsor is the operations director.\n')

    const after = interviewRounds(root)
    const stillAsked = after.flatMap((r) => r.documents.map((d) => d.key))
    expect(stillAsked).not.toContain(target.key)
  })

  it('drops a document that recorded an `unanswered` reason — that is an answer too', () => {
    const root = freshTree()
    const target = interviewRounds(root)[0]!.documents[0]!

    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    const abs = join(root, target.key)
    writeFileSync(
      abs,
      readFileSync(abs, 'utf8').replace('status: draft', 'status: draft\nunanswered: "Asked; nobody knows yet."'),
    )

    const stillAsked = interviewRounds(root).flatMap((r) => r.documents.map((d) => d.key))
    expect(stillAsked).not.toContain(target.key)
  })

  it('returns nothing at all once every document is settled — the interview is over', () => {
    const root = freshTree()
    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    for (const round of interviewRounds(root)) {
      for (const doc of round.documents) {
        const abs = join(root, doc.key)
        writeFileSync(
          abs,
          readFileSync(abs, 'utf8').replace('status: draft', 'status: draft\nunanswered: "Asked; not known."'),
        )
      }
    }
    expect(interviewRounds(root)).toEqual([])
  })

  it('renumbers so a resumed interview says "round 1 of 2", not "round 4 of 6"', () => {
    const root = freshTree()
    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    const all = interviewRounds(root)
    for (const round of all.slice(0, all.length - 2)) {
      for (const doc of round.documents) {
        const abs = join(root, doc.key)
        writeFileSync(
          abs,
          readFileSync(abs, 'utf8').replace('status: draft', 'status: draft\nunanswered: "Asked; not known."'),
        )
      }
    }
    const remaining = interviewRounds(root)
    expect(remaining).toHaveLength(2)
    expect(remaining.map((r) => [r.number, r.of])).toEqual([
      [1, 2],
      [2, 2],
    ])
  })
})

describe('contrail questions', () => {
  function inTree(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
    const root = mkdtempSync(join(tmpdir(), 'contrail-questions-cli-'))
    runInitTemplate(root, { client: 'Acme', project: 'Demo', startDate: '2026-09-16' })
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    return fn()
      .then((code) => ({ code, output: logs.join('\n') }))
      .finally(() => {
        process.chdir(cwd)
        spy.mockRestore()
      })
  }

  it('prints the first round with its theme, its documents and their questions', async () => {
    const { code, output } = await inTree(() => main(['questions']))
    expect(code).toBe(0)
    expect(output).toContain('Round 1 of 6')
    expect(output).toContain('Mandate and money')
    expect(output).toContain('docs/01-overview/charter.md')
    expect(output).toContain('Who sponsors this project, and what problem are they paying to solve?')
  })

  it('tells the reader to put the questions to a person, not to guess or bulk-mark', async () => {
    const { output } = await inTree(() => main(['questions']))
    expect(output).toMatch(/ask/i)
  })

  it('emits structured rounds under --json', async () => {
    const { code, output } = await inTree(() => main(['questions', '--json']))
    expect(code).toBe(0)
    const parsed = JSON.parse(output) as {
      rounds: { number: number; of: number; theme: string; documents: { key: string; questions: string[] }[] }[]
    }
    expect(parsed.rounds).toHaveLength(6)
    expect(parsed.rounds[0]?.number).toBe(1)
    expect(parsed.rounds[0]?.documents[0]?.questions.length).toBeGreaterThan(0)
  })

  it('says the interview is done once every document is settled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-questions-done-'))
    runInitTemplate(root, { client: 'Acme', project: 'Demo', startDate: '2026-09-16' })
    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    for (const round of interviewRounds(root)) {
      for (const doc of round.documents) {
        const abs = join(root, doc.key)
        writeFileSync(
          abs,
          readFileSync(abs, 'utf8').replace('status: draft', 'status: draft\nunanswered: "Asked; not known."'),
        )
      }
    }
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg))
    const cwd = process.cwd()
    process.chdir(root)
    let code: number
    try {
      code = await main(['questions'])
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }
    expect(code).toBe(0)
    expect(logs.join('\n')).toMatch(/no questions outstanding|interview is complete/i)
  })
})
