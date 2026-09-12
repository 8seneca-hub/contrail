import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import rehypeStringify from 'rehype-stringify'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Blockquote, Code, Link, Parent, Root, RootContent, Text } from 'mdast'
import { assetIdForDiagram, assetIdForFile, collectAssets, collectDiagrams } from '../assets.js'
import { matchAlert, stripAlertMarker, type AlertKind } from '../blocks/alert.js'
import { parseArchifyMeta } from '../blocks/archify.js'
import { parseArtifactMeta } from '../blocks/artifact.js'
import type { ArchifyOptions } from '../render/archify.js'
import type { Mmdc } from '../render/mermaid.js'
import type { Audience, Doc } from '../types.js'

const SITE_CSS_PATH = fileURLToPath(new URL('../../templates/site.css', import.meta.url))

export interface SiteEmitContext {
  /** `DiagramPlan.irPath` (absolute) -> path relative to the site root, e.g. "diagrams/<hash>.html". */
  diagramPaths: Record<string, string>
  /** `AssetPlan.id` -> path relative to the site root, e.g. "assets/<hash>.png". */
  assetPaths: Record<string, string>
  /**
   * Every known document's absolute path -> whether it is being emitted in
   * this build. Drives link defanging: a link into a document this build
   * will NOT emit must never reach the page as a working — or even
   * readable — href, because the href itself (e.g. `03-management/budget.md`)
   * would still name a document the reader was never meant to know exists.
   * A path absent from this map is not a document contrail knows about
   * (an external URL, an asset, ...) and is left untouched.
   */
  docVisibility: Map<string, boolean>
  /** Every link rewritten to plain text because its target is not visible in this build. */
  defangedLinks: DefangedLink[]
}

export interface DefangedLink {
  /** The document the link was found in. */
  doc: string
  /** The original (never-emitted) href. */
  url: string
}

export interface SiteResult {
  outDir: string
  /** Document keys, in the order they were written. */
  pages: string[]
  /** Number of distinct diagram artifacts copied into the output. */
  diagrams: number
  /** Links rewritten to plain text because their target was excluded from this build. */
  defangedLinks: DefangedLink[]
}

export function escapeHtml(value: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  return value.replace(/[&<>"]/g, (c) => map[c]!)
}

/** Every page lives flat at the output root, so root-relative links like
 * `diagrams/<hash>.html` and `assets/<hash>.png` resolve the same from any
 * page regardless of the document's original nesting. */
export function pageFileFor(key: string): string {
  return key.replace(/\.md$/, '.html').replace(/\//g, '__')
}

function figureForDiagram(path: string, summary: string): string {
  const safeSummary = escapeHtml(summary)
  return (
    '<figure class="diagram">' +
    `<iframe src="${escapeHtml(path)}" loading="lazy" title="${safeSummary}"></iframe>` +
    `<figcaption>${safeSummary}</figcaption>` +
    '</figure>'
  )
}

function figureForAsset(path: string, summary: string): string {
  const safeSummary = escapeHtml(summary)
  return (
    '<figure class="asset">' +
    `<img src="${escapeHtml(path)}" alt="${safeSummary}" loading="lazy">` +
    `<figcaption>${safeSummary}</figcaption>` +
    '</figure>'
  )
}

interface Replacement {
  /** Plain-text token stringify emits as `<p>TOKEN</p>`, swapped for the real markup afterward. */
  placeholder: string
  html: string
}

/**
 * Code blocks become raw HTML the reader never authored (iframes, figures),
 * so they are swapped in as a post-processing string replace on the final
 * HTML rather than as mdast "html" nodes fed back through an HTML parser —
 * rehype-raw decodes entities inside re-parsed raw HTML, which would unescape
 * a `&quot;` sitting inside our own `title="..."` attribute right back into a
 * literal quote and truncate it. A plain-text placeholder never gets parsed
 * as markup, so nothing gets a second, unwanted decode.
 */
function transformCodeBlocks(doc: Doc, tree: Root, ctx: SiteEmitContext): Replacement[] {
  const replacements: Replacement[] = []

  visit(tree, 'code', (node: Code, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`

    let markup: string | undefined
    if (node.lang === 'archify') {
      const meta = parseArchifyMeta(node.meta, where)
      const irPath = resolve(dirname(doc.absPath), meta.src)
      const path = ctx.diagramPaths[irPath]
      if (!path) throw new Error(`${where}: no rendered diagram found for ${meta.src}`)
      markup = figureForDiagram(path, meta.summary)
    } else if (node.lang === 'mermaid') {
      const id = assetIdForDiagram(node.value)
      const path = ctx.assetPaths[id]
      if (!path) throw new Error(`${where}: no rendered asset found for this mermaid diagram`)
      markup = `<img src="${escapeHtml(path)}" loading="lazy" alt="Diagram">`
    } else if (node.lang === 'artifact') {
      const meta = parseArtifactMeta(node.meta, where)
      const id = assetIdForFile(meta.fallback)
      const path = ctx.assetPaths[id]
      if (!path) throw new Error(`${where}: no rendered asset found for ${meta.fallback}`)
      markup = figureForAsset(path, meta.summary)
    }
    if (markup === undefined) return

    const placeholder = `CONTRAILSITEBLOCK${replacements.length}PLACEHOLDER`
    replacements.push({ placeholder, html: markup })
    parent.children.splice(index, 1, { type: 'paragraph', children: [{ type: 'text', value: placeholder }] })
  })

  return replacements
}

/** Concatenated text content of a link's children — its visible label, never its href. */
function linkText(node: Link): string {
  let text = ''
  visit(node, 'text', (t: Text) => {
    text += t.value
  })
  return text
}

/**
 * Resolves a link's `url` to the absolute path it would point at on disk, or
 * `undefined` when it plainly isn't a local document reference (an external
 * URL, a mailto:, an in-page anchor). Fragments and query strings are
 * stripped before resolving, so `budget.md#totals` still resolves to
 * `budget.md`.
 */
function resolveLinkTarget(doc: Doc, url: string): string | undefined {
  if (!url || url.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined
  const withoutFragment = url.split('#')[0]!.split('?')[0]!
  if (!withoutFragment) return undefined
  return resolve(dirname(doc.absPath), withoutFragment)
}

/**
 * A client-visible page must never carry a working — or readable — link to
 * a document this build excludes. `ctx.docVisibility` covers every document
 * contrail knows about (not just the ones being emitted), so a link into an
 * excluded one is recognized even though that document's own page was never
 * written. The link is replaced by its own plain text: no href survives,
 * because the href alone (e.g. `03-management/budget.md`) is enough to leak
 * that the document exists.
 */
function transformLinks(doc: Doc, tree: Root, ctx: SiteEmitContext): void {
  visit(tree, 'link', (node: Link, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return
    const target = resolveLinkTarget(doc, node.url)
    if (target === undefined) return
    const visible = ctx.docVisibility.get(target)
    if (visible === undefined || visible) return // not a document contrail tracks, or it is visible: leave it

    ctx.defangedLinks.push({ doc: doc.key, url: node.url })
    const text: Text = { type: 'text', value: linkText(node) }
    parent.children.splice(index, 1, text)
  })
}

const ALERT_CLASS: Record<AlertKind, string> = {
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'important',
  WARNING: 'warning',
  CAUTION: 'caution',
}

/** Renders a detached list of mdast nodes (an alert's stripped body) to HTML,
 * independent of the document's own tree walk — cheap, and keeps the alert
 * transform self-contained the same way `figureForDiagram` is. */
function renderNodesToHtml(nodes: RootContent[]): string {
  const processor = unified().use(remarkRehype).use(rehypeStringify)
  return processor.stringify(processor.runSync({ type: 'root', children: nodes } as Root))
}

/**
 * GitHub-style `> [!NOTE]` alerts become styled callouts. Same placeholder
 * technique as `transformCodeBlocks`: the blockquote's own children are
 * pre-rendered to HTML (they may hold arbitrary markdown) and swapped in
 * after the main stringify pass, so the marker text never reaches the page.
 */
function transformAlerts(tree: Root): Replacement[] {
  const replacements: Replacement[] = []
  visit(tree, 'blockquote', (node: Blockquote, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return
    const alert = matchAlert(node)
    if (!alert) return
    stripAlertMarker(node)

    const innerHtml = renderNodesToHtml(node.children as RootContent[])
    const html =
      `<div class="callout callout-${ALERT_CLASS[alert.kind]}">` +
      `<p class="callout-label">${escapeHtml(alert.label)}</p>${innerHtml}</div>`

    const placeholder = `CONTRAILSITEALERT${replacements.length}PLACEHOLDER`
    replacements.push({ placeholder, html })
    parent.children.splice(index, 1, { type: 'paragraph', children: [{ type: 'text', value: placeholder }] })
  })
  return replacements
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="site.css">
</head>
<body>
${body}
</body>
</html>
`
}

export function emitSite(doc: Doc, ctx: SiteEmitContext): string {
  const tree = structuredClone(doc.tree) as Root
  transformLinks(doc, tree, ctx)
  const replacements = transformCodeBlocks(doc, tree, ctx)
  replacements.push(...transformAlerts(tree))

  const processor = unified().use(remarkRehype).use(rehypeStringify)
  let bodyHtml = processor.stringify(processor.runSync(tree))
  for (const { placeholder, html } of replacements) {
    bodyHtml = bodyHtml.replace(`<p>${placeholder}</p>`, html)
  }

  const { title, summary, status } = doc.frontmatter
  const body = `<header class="page-header">
<p class="breadcrumb"><a href="index.html">&larr; All documents</a></p>
<h1>${escapeHtml(title)}</h1>
<p class="summary">${escapeHtml(summary)}</p>
<span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span>
</header>
<main>
${bodyHtml}
</main>`

  return pageShell(title, body)
}

function emitIndex(docs: Doc[]): string {
  const rows = docs
    .map(
      (doc) => `<li class="doc-entry">
<a href="${escapeHtml(pageFileFor(doc.key))}">${escapeHtml(doc.frontmatter.title)}</a>
<span class="status status-${escapeHtml(doc.frontmatter.status)}">${escapeHtml(doc.frontmatter.status)}</span>
<p>${escapeHtml(doc.frontmatter.summary)}</p>
</li>`,
    )
    .join('\n')

  const body = `<header class="page-header">
<h1>Documentation</h1>
</header>
<main>
<ul class="doc-list">
${rows}
</ul>
</main>`

  return pageShell('Documentation', body)
}

/** Every document contrail knows about that would be published for the given audience filter.
 * `undefined` (no `--audience` flag) publishes everything — the audience gate is strictly opt-in. */
export function docsForAudience(docs: Doc[], audience: Audience | undefined): Doc[] {
  if (audience === undefined) return docs
  return docs.filter((doc) => doc.frontmatter.audience === audience)
}

export async function buildSite(args: {
  /** Every document contrail knows about — not just the ones being emitted.
   * The full set is required even for a filtered build, so link defanging
   * can recognize a link into a document this build excludes. */
  docs: Doc[]
  outDir: string
  cacheDir: string
  mmdc?: Mmdc
  archify?: ArchifyOptions
  /** `'client'` emits only `audience: client` documents. Omitted, the default publishes everything. */
  audience?: Audience
}): Promise<SiteResult> {
  const { docs, outDir, cacheDir, mmdc, archify, audience } = args
  const emitted = docsForAudience(docs, audience)
  const emittedKeys = new Set(emitted.map((doc) => doc.key))
  const docVisibility = new Map(docs.map((doc) => [resolve(doc.absPath), emittedKeys.has(doc.key)]))

  mkdirSync(outDir, { recursive: true })
  mkdirSync(join(outDir, 'diagrams'), { recursive: true })
  mkdirSync(join(outDir, 'assets'), { recursive: true })
  copyFileSync(SITE_CSS_PATH, join(outDir, 'site.css'))

  const diagramPaths: Record<string, string> = {}
  const assetPaths: Record<string, string> = {}
  let diagramCount = 0

  // Diagrams and assets are collected only from documents actually being
  // emitted — an internal document's diagram must not become an unlinked
  // public file in a client build any more than the document's own page may.
  for (const doc of emitted) {
    for (const plan of await collectDiagrams(doc, { cacheDir, archify })) {
      if (!(plan.irPath in diagramPaths)) {
        const rel = `diagrams/${plan.hash}.html`
        copyFileSync(plan.htmlPath, join(outDir, rel))
        diagramPaths[plan.irPath] = rel
        diagramCount++
      }
    }

    for (const plan of await collectAssets(doc, { cacheDir, mmdc })) {
      if (!(plan.id in assetPaths)) {
        const ext = extname(plan.filePath) || '.bin'
        const rel = `assets/${plan.hash}${ext}`
        copyFileSync(plan.filePath, join(outDir, rel))
        assetPaths[plan.id] = rel
      }
    }
  }

  const defangedLinks: DefangedLink[] = []
  const ctx: SiteEmitContext = { diagramPaths, assetPaths, docVisibility, defangedLinks }
  const pages: string[] = []
  for (const doc of emitted) {
    writeFileSync(join(outDir, pageFileFor(doc.key)), emitSite(doc, ctx))
    pages.push(doc.key)
  }

  writeFileSync(join(outDir, 'index.html'), emitIndex(emitted))

  return { outDir, pages, diagrams: diagramCount, defangedLinks }
}
