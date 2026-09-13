import { basename } from 'node:path'
import { cardinalityOf, type DocKind } from './doc-kinds.js'
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
  /** Why this document was selected — an agent that knows the reason can tell when the
   * selection was wrong, which is the whole point of returning a ranked list instead of a path. */
  reason: string
  score: number
}

export interface ContextQuery {
  task?: TaskType
  keywords?: string[]
  audience?: Audience
  limit?: number
}

/** A keyword's hits in one document's title/summary/tags. Title counts most because it is what an
 * agent scans first; a tag hit counts least because it is the least specific kind of match. */
function keywordHits(doc: Doc, keywords: string[]): { score: number; matched: string[] } {
  const title = doc.frontmatter.title.toLowerCase()
  const summary = doc.frontmatter.summary.toLowerCase()
  const tags = (doc.frontmatter.tags ?? []).map((t) => t.toLowerCase())

  let score = 0
  const matched: string[] = []
  for (const raw of keywords) {
    const kw = raw.trim().toLowerCase()
    if (!kw) continue
    let hit = false
    if (title.includes(kw)) {
      score += 5
      hit = true
    }
    if (summary.includes(kw)) {
      score += 3
      hit = true
    }
    if (tags.some((t) => t.includes(kw))) {
      score += 2
      hit = true
    }
    if (hit) matched.push(raw)
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
 * Ranks `docs` for a task and/or a keyword query, per task-1-brief.md's four ranking rules:
 *
 * 1. `docKind` matching the task's list — earlier entries in that list outrank later ones.
 * 2. Keyword matches in title, summary or tags add to the score.
 * 3. `status: current` outranks `draft`; `status: stale` sinks to the bottom and is labelled in
 *    its `reason`, never dropped — a stale document may be the only record of something.
 * 4. For collection docKinds (`meeting`, `adr`, `change-request`, `qa-report`, `release`),
 *    recency breaks ties: newest meeting, highest-numbered ADR. Every one of those docKinds is
 *    scaffolded with its discriminator (an ISO date or a zero-padded number) leading the
 *    filename — see `COLLECTION_META`/`title-convention.test.ts` — so comparing basenames as
 *    plain strings, descending, already sorts newest-or-highest first with no date parsing.
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
    const reasons: string[] = []
    // Rule 3 first: stale sinks below every non-stale document regardless of how well it
    // otherwise matches — labelled, never silently dropped.
    let score = isStale ? 0 : 1_000_000

    if (kinds) {
      const idx = doc.frontmatter.docKind ? kinds.indexOf(doc.frontmatter.docKind) : -1
      score += (kinds.length - idx) * 1000
      reasons.push(
        `docKind '${doc.frontmatter.docKind}' ranks ${idx + 1} of ${kinds.length} in the '${query.task}' task's document list`,
      )
    }

    if (keywords.length > 0) {
      const { score: kwScore, matched } = keywordHits(doc, keywords)
      score += kwScore * 10
      if (matched.length > 0) {
        reasons.push(`matched keyword(s) ${matched.map((k) => `'${k}'`).join(', ')}`)
      }
    }

    score += statusWeight(doc.frontmatter.status) * 5

    if (isStale) {
      reasons.push('status is `stale` — ranked last, kept rather than dropped')
    } else {
      reasons.push(`status: ${doc.frontmatter.status}`)
    }

    if (doc.frontmatter.docKind && cardinalityOf(doc.frontmatter.docKind) === 'collection') {
      reasons.push('tied documents of this docKind are broken by recency (newest/highest-numbered first)')
    }

    return {
      path: doc.key,
      title: doc.frontmatter.title,
      summary: doc.frontmatter.summary,
      docKind: doc.frontmatter.docKind,
      status: doc.frontmatter.status,
      reason: reasons.join('; '),
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
