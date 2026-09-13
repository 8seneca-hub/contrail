import { basename } from 'node:path'
import type { DocKind } from './doc-kinds.js'
import { docsForAudience } from './emit/site.js'
import type { Audience, Doc, DocStatus } from './types.js'

/**
 * `contrail context`'s task vocabulary and its docKind lists. THIS IS THE SAME TABLE as the
 * "Which documents for which task" table in `docs/using-contrail.md` — one fact, two homes,
 * because a person reads the usage guide and an agent reads `--task <type>`; keeping a single
 * source meant one of them reading the other across a doc/code boundary, which was judged more
 * fragile than restating it and keeping both in this milestone's review. Change one, change both.
 *
 * Order matters within each list: earlier `docKind`s rank higher for that task, because the list
 * is written in the order a reader actually needs the documents (task-1-brief.md).
 */
export type TaskType =
  | 'feature'
  | 'estimate'
  | 'scope'
  | 'decision'
  | 'client-call'
  | 'onboard'
  | 'test'
  | 'deploy'
  | 'risk'

export const TASK_TYPES: readonly TaskType[] = [
  'feature',
  'estimate',
  'scope',
  'decision',
  'client-call',
  'onboard',
  'test',
  'deploy',
  'risk',
]

export function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value)
}

export const TASK_DOC_KINDS: Readonly<Record<TaskType, readonly DocKind[]>> = {
  feature: ['prd', 'architecture', 'api-reference', 'adr'],
  estimate: ['estimate', 'assumptions', 'wbs', 'scope'],
  scope: ['scope', 'change-request', 'assumptions'],
  decision: ['adr', 'architecture'],
  'client-call': ['open-questions', 'meeting', 'change-request', 'scope'],
  onboard: ['charter', 'glossary', 'architecture', 'prd'],
  test: ['test-plan', 'qa-report', 'prd'],
  deploy: ['deployment', 'release', 'architecture'],
  risk: ['risk-log', 'assumptions', 'open-questions'],
}

export interface ContextEntry {
  path: string
  title: string
  summary: string
  docKind?: DocKind
  status: DocStatus
  /** Why this document was selected, as short machine-readable codes (`docKind:adr`,
   * `keyword:contingency`, `stale`) rather than a sentence — the shared ranking rule is stated
   * once in `contextRule`/the CLI header, so a row need not restate it. A JSON consumer reads
   * this directly; it should never have to parse prose. */
  reason: string
  /** Human-only elaboration for a row the shared rule does NOT already explain (a keyword hit
   * and where it landed, a stale warning). Undefined when the row ranked exactly as the header
   * says, because the header already said it. Stripped from `--json` output — machine consumers
   * use `reason` instead. */
  note?: string
  score: number
}

export interface ContextQuery {
  task?: TaskType
  keywords?: string[]
  audience?: Audience
  limit?: number
}

type KeywordMatch = { keyword: string; field: 'title' | 'summary' | 'tags' }

/** A keyword's hits in one document's title/summary/tags. Title counts most because it is what an
 * agent scans first; a tag hit counts least because it is the least specific kind of match. Each
 * matched keyword also records its strongest-scoring field, so the reporting layer can say
 * *where* it landed instead of just that it landed. */
function keywordHits(doc: Doc, keywords: string[]): { score: number; matched: KeywordMatch[] } {
  const title = doc.frontmatter.title.toLowerCase()
  const summary = doc.frontmatter.summary.toLowerCase()
  const tags = (doc.frontmatter.tags ?? []).map((t) => t.toLowerCase())

  let score = 0
  const matched: KeywordMatch[] = []
  for (const raw of keywords) {
    const kw = raw.trim().toLowerCase()
    if (!kw) continue
    let field: KeywordMatch['field'] | undefined
    if (title.includes(kw)) {
      score += 5
      field = 'title'
    }
    if (summary.includes(kw)) {
      score += 3
      field ??= 'summary'
    }
    if (tags.some((t) => t.includes(kw))) {
      score += 2
      field ??= 'tags'
    }
    if (field) matched.push({ keyword: raw, field })
  }
  return { score, matched }
}

/** `status: current` outranks `draft`; `stale` is handled separately (see `contextQuery`) because
 * it must sink to the very bottom of the result, not merely lose a few points. */
function statusWeight(status: DocStatus): number {
  if (status === 'current') return 2
  if (status === 'review') return 1
  return 0
}

/**
 * States, once, the ranking rule that would otherwise be repeated on every row of a
 * `contextQuery` result — the shared explanation the CLI header prints and `--json` carries as
 * a top-level `rule` string. Must stay consistent with the rules `contextQuery` actually applies;
 * it is not re-derived from the result set because the rule is fixed by the query shape, not by
 * which documents happened to match.
 */
export function contextRule(query: ContextQuery): string {
  const hasKeywords = (query.keywords ?? []).some((k) => k.trim().length > 0)
  if (query.task) {
    return `Task '${query.task}': ranked by docKind (${TASK_DOC_KINDS[query.task].join(' > ')}), then status, then recency.`
  }
  if (hasKeywords) {
    return 'Ranked by keyword match score, then status, then recency.'
  }
  return 'Ranked by status, then recency.'
}

/**
 * Ranks `docs` for a task and/or a keyword query, per task-1-brief.md's four ranking rules:
 *
 * 1. `docKind` matching the task's list — earlier entries in that list outrank later ones.
 * 2. Keyword matches in title, summary or tags add to the score.
 * 3. `status: current` outranks `draft`; `status: stale` sinks to the bottom, never dropped — a
 *    stale document may be the only record of something.
 * 4. For collection docKinds (`meeting`, `adr`, `change-request`, `qa-report`, `release`),
 *    recency breaks ties: newest meeting, highest-numbered ADR. Every one of those docKinds is
 *    scaffolded with its discriminator (an ISO date or a zero-padded number) leading the
 *    filename — see `COLLECTION_META`/`title-convention.test.ts` — so comparing basenames as
 *    plain strings, descending, already sorts newest-or-highest first with no date parsing.
 *
 * Rules 1, 3 and 4 apply identically to every row in a given query, so they are stated ONCE, by
 * `contextRule`, rather than re-derived per row (see task-1-brief.md's cost note: repeating a
 * ~40-token ranking sentence on every one of N rows defeats a tool whose job is saving context).
 * A row's own `reason`/`note` therefore carries only what the shared rule does not already say:
 * a keyword hit (rule 2, which varies per document) and a stale warning (rule 3's one exception,
 * which is a demotion, not just an ordering).
 *
 * `--audience` is enforced by reusing `docsForAudience` (`emit/site.ts`) — the exact function
 * that gives the site and `llms.txt` their client/internal guarantee — rather than a second
 * filter that could drift from it. An agent working on a client's behalf must never see an
 * internal document from either surface.
 */
export function contextQuery(allDocs: Doc[], query: ContextQuery): ContextEntry[] {
  const scoped = docsForAudience(allDocs, query.audience)
  const kinds = query.task ? TASK_DOC_KINDS[query.task] : undefined
  const keywords = (query.keywords ?? []).filter((k) => k.trim().length > 0)

  const candidates = scoped.filter((doc) => {
    if (kinds) return doc.frontmatter.docKind !== undefined && kinds.includes(doc.frontmatter.docKind)
    if (keywords.length > 0) return keywordHits(doc, keywords).matched.length > 0
    return true
  })

  const entries = candidates.map((doc) => {
    const isStale = doc.frontmatter.status === 'stale'
    // Machine-readable codes (every row, always) vs. human prose for what the shared rule
    // (`contextRule`) does not already cover (keyword hits, a stale warning).
    const codes: string[] = []
    const notes: string[] = []
    // Rule 3 first: stale sinks below every non-stale document regardless of how well it
    // otherwise matches — never silently dropped.
    let score = isStale ? 0 : 1_000_000

    if (kinds && doc.frontmatter.docKind) {
      const idx = kinds.indexOf(doc.frontmatter.docKind)
      score += (kinds.length - idx) * 1000
      codes.push(`docKind:${doc.frontmatter.docKind}`)
    }

    if (keywords.length > 0) {
      const { score: kwScore, matched } = keywordHits(doc, keywords)
      score += kwScore * 10
      for (const m of matched) {
        codes.push(`keyword:${m.keyword}`)
        notes.push(`matched "${m.keyword}" in ${m.field}`)
      }
    }

    score += statusWeight(doc.frontmatter.status) * 5

    if (isStale) {
      codes.push('stale')
      notes.push('stale — may be the only record; verify before relying on it')
    }

    return {
      path: doc.key,
      title: doc.frontmatter.title,
      summary: doc.frontmatter.summary,
      docKind: doc.frontmatter.docKind,
      status: doc.frontmatter.status,
      reason: codes.join(','),
      note: notes.length > 0 ? notes.join('; ') : undefined,
      score,
      basename: basename(doc.key),
    }
  })

  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.basename.localeCompare(a.basename)
  })

  const limited = query.limit !== undefined ? entries.slice(0, query.limit) : entries
  return limited.map(({ basename: _basename, ...rest }) => rest)
}

/** Printed (and, in `--json` mode, carried as a `message` field) when a query matches nothing —
 * an empty tree, or a task/keyword combination nothing satisfies. Must say so rather than error:
 * an empty result is a valid answer, not a usage mistake. */
export function contextEmptyMessage(query: ContextQuery): string {
  const what = query.task
    ? `task '${query.task}'`
    : query.keywords && query.keywords.length > 0
      ? `keyword(s) ${query.keywords.map((k) => `'${k}'`).join(', ')}`
      : 'this query'
  return `contrail context: no documents matched ${what}. Nothing was found — this is not an error.`
}
