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
  // SAFETY: a document nobody classified must never be publishable to a
  // client. Absent `audience` defaults to the safe value, not a guess.
  fm.audience = fm.audience ?? 'internal'

  if (fm.section !== undefined && !SECTIONS.includes(fm.section)) {
    throw new DocError(`${key}: frontmatter \`section\` must be one of ${SECTIONS.join(', ')}.`)
  }

  if (fm.docKind !== undefined && !DOC_KINDS.includes(fm.docKind)) {
    throw new DocError(`${key}: frontmatter \`docKind\` must be one of ${DOC_KINDS.join(', ')}.`)
  }

  const tree = unified().use(remarkParse).use(remarkGfm).parse(content)
  return { absPath, key, frontmatter: fm as Frontmatter, tree, body: content }
}
