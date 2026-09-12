import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import matter from 'gray-matter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Doc, DocStatus, Frontmatter } from './types.js'

const STATUSES: readonly DocStatus[] = ['draft', 'review', 'current', 'stale']

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

  const tree = unified().use(remarkParse).use(remarkGfm).parse(content)
  return { absPath, key, frontmatter: fm as Frontmatter, tree, body: content }
}
