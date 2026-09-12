import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import rehypeStringify from 'rehype-stringify'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Code, Parent, Root } from 'mdast'
import { assetIdForDiagram, assetIdForFile, collectAssets, collectDiagrams } from '../assets.js'
import { parseArchifyMeta } from '../blocks/archify.js'
import { parseArtifactMeta } from '../blocks/artifact.js'
import type { ArchifyOptions } from '../render/archify.js'
import type { Mmdc } from '../render/mermaid.js'
import type { Doc } from '../types.js'

const SITE_CSS_PATH = fileURLToPath(new URL('../../templates/site.css', import.meta.url))

export interface SiteEmitContext {
  /** `DiagramPlan.irPath` (absolute) -> path relative to the site root, e.g. "diagrams/<hash>.html". */
  diagramPaths: Record<string, string>
  /** `AssetPlan.id` -> path relative to the site root, e.g. "assets/<hash>.png". */
  assetPaths: Record<string, string>
}

export interface SiteResult {
  outDir: string
  /** Document keys, in the order they were written. */
  pages: string[]
  /** Number of distinct diagram artifacts copied into the output. */
  diagrams: number
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
  const replacements = transformCodeBlocks(doc, tree, ctx)

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

export async function buildSite(args: {
  docs: Doc[]
  outDir: string
  cacheDir: string
  mmdc?: Mmdc
  archify?: ArchifyOptions
}): Promise<SiteResult> {
  const { docs, outDir, cacheDir, mmdc, archify } = args

  mkdirSync(outDir, { recursive: true })
  mkdirSync(join(outDir, 'diagrams'), { recursive: true })
  mkdirSync(join(outDir, 'assets'), { recursive: true })
  copyFileSync(SITE_CSS_PATH, join(outDir, 'site.css'))

  const diagramPaths: Record<string, string> = {}
  const assetPaths: Record<string, string> = {}
  let diagramCount = 0

  for (const doc of docs) {
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

  const ctx: SiteEmitContext = { diagramPaths, assetPaths }
  const pages: string[] = []
  for (const doc of docs) {
    writeFileSync(join(outDir, pageFileFor(doc.key)), emitSite(doc, ctx))
    pages.push(doc.key)
  }

  writeFileSync(join(outDir, 'index.html'), emitIndex(docs))

  return { outDir, pages, diagrams: diagramCount }
}
