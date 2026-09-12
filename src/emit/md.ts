import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Code, Parent, Root, RootContent } from 'mdast'
import { parseArtifactMeta } from '../blocks/artifact.js'
import type { Doc } from '../types.js'

export function emitMarkdown(doc: Doc): string {
  const tree = structuredClone(doc.tree) as Root

  visit(tree, 'code', (node: Code, index: number | undefined, parent: Parent | undefined) => {
    if (node.lang !== 'artifact' || parent === undefined || index === undefined) return
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`
    const meta = parseArtifactMeta(node.meta, where)
    const replacement: RootContent[] = [
      {
        type: 'paragraph',
        children: [{ type: 'image', url: meta.fallback, alt: meta.summary }],
      },
      { type: 'paragraph', children: [{ type: 'text', value: meta.summary }] },
    ]
    parent.children.splice(index, 1, ...replacement)
  })

  return String(unified().use(remarkGfm).use(remarkStringify, { fences: true }).stringify(tree))
}
