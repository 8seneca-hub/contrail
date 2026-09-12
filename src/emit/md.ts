import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Code, Parent, Root, RootContent } from 'mdast'
import { parseArchifyMeta } from '../blocks/archify.js'
import { parseArtifactMeta } from '../blocks/artifact.js'
import type { Doc } from '../types.js'

export function emitMarkdown(doc: Doc): string {
  const tree = structuredClone(doc.tree) as Root

  visit(tree, 'code', (node: Code, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`

    if (node.lang === 'artifact') {
      const meta = parseArtifactMeta(node.meta, where)
      const replacement: RootContent[] = [
        {
          type: 'paragraph',
          children: [{ type: 'image', url: meta.fallback, alt: meta.summary }],
        },
        { type: 'paragraph', children: [{ type: 'text', value: meta.summary }] },
      ]
      parent.children.splice(index, 1, ...replacement)
      return
    }

    if (node.lang === 'archify') {
      // Agents reading the typed IR get more than a picture would give them,
      // so the archify block becomes the summary plus a link to the IR JSON
      // rather than any rendered form.
      const meta = parseArchifyMeta(node.meta, where)
      const replacement: RootContent[] = [
        { type: 'paragraph', children: [{ type: 'text', value: meta.summary }] },
        {
          type: 'paragraph',
          children: [{ type: 'link', url: meta.src, children: [{ type: 'text', value: meta.src }] }],
        },
      ]
      parent.children.splice(index, 1, ...replacement)
    }
  })

  return String(unified().use(remarkGfm).use(remarkStringify, { fences: true }).stringify(tree))
}
