import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Blockquote, Code, Html, Parent, Root, RootContent } from 'mdast'
import { assetIdForDiagram, assetIdForFile } from '../assets.js'
import { matchAlert, stripAlertMarker } from '../blocks/alert.js'
import { parseArtifactMeta } from '../blocks/artifact.js'
import type { Doc } from '../types.js'
import { planeSchema } from './plane-schema.js'

export interface PlaneEmitContext {
  /** Asset id from `src/assets.ts` to the Plane asset UUID returned by upload. */
  assetIds: Record<string, string>
  /** ISO date shown in the page footer. */
  updated: string
  /** Link to the interactive version, when one has been published. */
  siteUrl?: string
}

const html = (value: string): Html => ({ type: 'html', value })

/** Plane references an uploaded page asset by its asset id. See the note in the plan. */
function imageSrc(assetUuid: string): string {
  return assetUuid
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function imageComponent(assetUuid: string, id: string): Html {
  return html(
    `<image-component id="${escapeHtml(id)}" src="${escapeHtml(imageSrc(assetUuid))}" ` +
      'alignment="center" status="uploaded"></image-component>',
  )
}

function callout(background: string, emojiUnicode: string, inner: RootContent[]): RootContent[] {
  return [
    html(
      `<div data-block-type="callout-component" data-background="${background}" ` +
        `data-logo-in-use="emoji" data-emoji-unicode="${emojiUnicode}">`,
    ),
    ...inner,
    html('</div>'),
  ]
}

function text(value: string): RootContent {
  return { type: 'paragraph', children: [{ type: 'text', value }] }
}

function transformAlerts(tree: Root): void {
  visit(tree, 'blockquote', (node: Blockquote, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return
    const alert = matchAlert(node)
    if (!alert) return
    stripAlertMarker(node)
    parent.children.splice(index, 1, ...callout(alert.background, alert.emojiUnicode, node.children as RootContent[]))
  })
}

function transformCodeBlocks(doc: Doc, tree: Root, ctx: PlaneEmitContext): void {
  visit(tree, 'code', (node: Code, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return

    if (node.lang === 'mermaid') {
      const id = assetIdForDiagram(node.value)
      const uuid = ctx.assetIds[id]
      if (!uuid) throw new Error(`${doc.key}: no uploaded asset for diagram ${id}`)
      parent.children.splice(index, 1, imageComponent(uuid, id))
      return
    }

    if (node.lang === 'artifact') {
      const where = `${doc.key}:${node.position?.start.line ?? '?'}`
      const meta = parseArtifactMeta(node.meta, where)
      const id = assetIdForFile(meta.fallback)
      const uuid = ctx.assetIds[id]
      if (!uuid) throw new Error(`${where}: no uploaded asset for fallback ${meta.fallback}`)
      parent.children.splice(index, 1, imageComponent(uuid, id), text(meta.summary))
      return
    }

    if (node.lang === 'archify' || node.lang === 'sheet') {
      // Both fences are meta-only — no rendered body to fall back on the way
      // `mermaid` and `artifact` have an uploaded asset. `site.ts` and `md.ts`
      // throw rather than silently drop the diagram or the live-sheet table;
      // the Plane emitter must not be the one place that loses content
      // quietly. This is dormant while Plane Community lacks the Pages API —
      // loud failure now is correct so it stays loud the day that changes,
      // rather than corrupting a published page silently. Implementing
      // `archify`/`sheet` rendering for Plane is separate reactivation work.
      const where = `${doc.key}:${node.position?.start.line ?? '?'}`
      throw new Error(`${where}: the Plane emitter does not yet support \`${node.lang}\` blocks.`)
    }
  })
}

const STATUS_NOTICE: Record<string, { background: string; emoji: string; message: string }> = {
  draft: { background: '#fffbeb', emoji: '9888', message: 'Draft — this document is still being written.' },
  review: { background: '#eff6ff', emoji: '128161', message: 'In review — content may still change.' },
  stale: {
    background: '#fef2f2',
    emoji: '9940',
    message: 'Stale — this document is known to be out of date. Do not rely on it.',
  },
}

export function emitPlane(doc: Doc, ctx: PlaneEmitContext): string {
  const tree = structuredClone(doc.tree) as Root

  transformAlerts(tree)
  transformCodeBlocks(doc, tree, ctx)

  const notice = STATUS_NOTICE[doc.frontmatter.status]
  if (notice) {
    tree.children.unshift(...callout(notice.background, notice.emoji, [text(notice.message)]))
  }

  if (ctx.siteUrl) {
    tree.children.unshift(
      ...callout('#eff6ff', '128279', [
        {
          type: 'paragraph',
          children: [{ type: 'link', url: ctx.siteUrl, children: [{ type: 'text', value: 'Interactive version' }] }],
        },
      ]),
    )
  }

  tree.children.push(
    html('<hr />'),
    text(`Source: ${doc.key} · updated ${ctx.updated} · status: ${doc.frontmatter.status}`),
    text('Generated by contrail. Edit the Markdown source, not this page.'),
  )

  const processor = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, planeSchema)
    .use(rehypeStringify)

  return processor.stringify(processor.runSync(tree))
}
