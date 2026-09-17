import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import matter from 'gray-matter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { DOC_KINDS, SECTIONS } from './doc-kinds.js'
import type { Doc, DocStatus, Frontmatter } from './types.js'

const STATUSES: readonly DocStatus[] = ['draft', 'review', 'current', 'stale']
const AUDIENCES = ['internal', 'client'] as const

export class DocError extends Error {}

export function parseDoc(absPath: string, root: string): Doc {
  const key = relative(root, absPath).split(sep).join('/')
  const { data, content } = matter(readFileSync(absPath, 'utf8'))
  const fm = data as Partial<Frontmatter>

  if (!fm.title) {
    throw new DocError(`${key}: frontmatter is missing required field \`title\`.`)
  }
  if (!fm.summary) {
    throw new DocError(
      `${key}: frontmatter is missing required field \`summary\`. ` +
        'It feeds the agent index and the Plane page excerpt.',
    )
  }
  if (!fm.status || !STATUSES.includes(fm.status)) {
    throw new DocError(`${key}: frontmatter \`status\` must be one of ${STATUSES.join(', ')}.`)
  }

  if (fm.audience !== undefined && !AUDIENCES.includes(fm.audience)) {
    throw new DocError(`${key}: frontmatter \`audience\` must be one of ${AUDIENCES.join(', ')}.`)
  }
  const audienceExplicit = fm.audience !== undefined
  // SAFETY: a document nobody classified must never be publishable to a
  // client. Absent `audience` defaults to the safe value, not a guess.
  fm.audience = fm.audience ?? 'internal'

  if (fm.section !== undefined && !SECTIONS.includes(fm.section)) {
    throw new DocError(`${key}: frontmatter \`section\` must be one of ${SECTIONS.join(', ')}.`)
  }

  if (fm.docKind !== undefined && !DOC_KINDS.includes(fm.docKind)) {
    throw new DocError(`${key}: frontmatter \`docKind\` must be one of ${DOC_KINDS.join(', ')}.`)
  }

  // The reason is the whole point of the field: it is what a reader gets
  // instead of the answer. `unanswered: true` records nothing, so it is
  // rejected as firmly as a missing title.
  if (fm.unanswered !== undefined) {
    if (typeof fm.unanswered !== 'string') {
      throw new DocError(
        `${key}: frontmatter \`unanswered\` must be a string saying why the guiding questions ` +
          'cannot be answered yet.',
      )
    }
    if (fm.unanswered.trim() === '') {
      throw new DocError(
        `${key}: frontmatter \`unanswered\` must be a non-empty reason — name what is missing and ` +
          'who or what it is blocked on.',
      )
    }
  }

  if (fm.nodiagram !== undefined) {
    if (typeof fm.nodiagram !== 'string') {
      throw new DocError(
        `${key}: frontmatter \`nodiagram\` must be a string saying why this document has no ` +
          'diagram.',
      )
    }
    if (fm.nodiagram.trim() === '') {
      throw new DocError(
        `${key}: frontmatter \`nodiagram\` must be a non-empty reason — say what there is no ` +
          'shape to draw.',
      )
    }
  }

  // js-yaml (via gray-matter) auto-parses an unquoted YAML date
  // (`reviewedOn: 2026-09-01`) into a real Date object, not the ISO string
  // the schema promises. Normalize here, once, so every consumer of
  // `reviewedOn` can trust it is actually a string.
  const rawReviewedOn = fm.reviewedOn as unknown
  if (rawReviewedOn instanceof Date) {
    fm.reviewedOn = rawReviewedOn.toISOString().slice(0, 10)
  }

  const tree = unified().use(remarkParse).use(remarkGfm).parse(content)
  return { absPath, key, frontmatter: fm as Frontmatter, tree, body: content, audienceExplicit }
}
