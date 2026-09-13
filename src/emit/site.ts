import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, posix, resolve } from 'node:path'
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
import { parseSheetMeta, type SheetMeta } from '../blocks/sheet.js'
import { SECTIONS, type Section } from '../doc-kinds.js'
import type { ArchifyOptions } from '../render/archify.js'
import type { Mmdc } from '../render/mermaid.js'
import { getSnapshot, sheetUrlFor, type SheetSnapshot } from '../sheets/snapshot.js'
import type { Audience, Doc } from '../types.js'

const SITE_CSS_PATH = fileURLToPath(new URL('../../templates/site.css', import.meta.url))

export interface SiteEmitContext {
  /** `DiagramPlan.irPath` (absolute) -> path relative to the site root, e.g. "diagrams/<hash>.html". */
  diagramPaths: Record<string, string>
  /** `AssetPlan.id` -> path relative to the site root, e.g. "assets/<hash>.png". */
  assetPaths: Record<string, string>
  /**
   * Every known document's absolute path -> its emitted page file (root-
   * relative, e.g. `"04-technical/prd.html"`) and whether it is being
   * emitted in this build. Drives both link rewriting and link defanging:
   * a visible link is rewritten to the correct relative href for the
   * (possibly nested) output; a link into a document this build will NOT
   * emit must never reach the page as a working — or even readable — href,
   * because the href itself (e.g. `03-management/budget.md`) would still
   * name a document the reader was never meant to know exists. A path
   * absent from this map is not a document contrail knows about (an
   * external URL, an asset, ...) and is left untouched, unless `filtered`
   * and it looks like a section-directory path — see `isSectionPath`.
   */
  docs: Map<string, { pageFile: string; visible: boolean }>
  /**
   * Whether this build is filtered to an audience (`site --audience client`),
   * as opposed to the unfiltered "publish everything" default. Only a
   * filtered build defangs a link into a section directory that `docVisibility`
   * has no entry for at all — a link to a non-`.md` file (a PDF, a spreadsheet
   * export) never becomes a tracked `Doc`, so `docVisibility` can't say
   * whether it's visible; a section-directory link like that is exactly the
   * shape of an internal-file leak a client build must not emit.
   */
  filtered: boolean
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

/**
 * The site mirrors the source doc tree: `docs/04-technical/prd.md` emits to
 * `04-technical/prd.html`, real nested directories and all. The leading
 * `docs/` segment is dropped — it is noise at the root of a docs site.
 * `diagrams/` and `assets/` stay at the site root regardless (they're
 * content-addressed and shared across documents); callers reach them via
 * `rootPrefixFor`, not by assuming every page is a root-level sibling.
 */
export function pageFileFor(key: string): string {
  return key.replace(/^docs\//, '').replace(/\.md$/, '.html')
}

/** "../" once per directory level `pageFile` sits below the site root — the
 * number of steps back to reach `diagrams/`, `assets/`, `site.css` or
 * `index.html`, all of which live at the root regardless of how deep the
 * page emitting the reference is nested. */
function rootPrefixFor(pageFile: string): string {
  const dir = posix.dirname(pageFile)
  return dir === '.' ? '' : `${dir.split('/').map(() => '..').join('/')}/`
}

/** A relative href from one emitted page to another, computed on their
 * actual (possibly nested) output locations — the original markdown-relative
 * URL was written against the source tree and rarely still matches once
 * sections emit into real directories. */
function relativeHref(fromPageFile: string, toPageFile: string): string {
  return posix.relative(posix.dirname(fromPageFile), toPageFile)
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

/** Pads every row to the width of the widest row, so a ragged range (Google Sheets omits trailing
 * empty cells) still renders a well-formed, rectangular table. */
function padRows(rows: string[][]): string[][] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''))
}

function htmlTableFor(rows: string[][]): string {
  const body = padRows(rows)
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<table class="sheet-table">${body}</table>`
}

function figureForSheet(meta: SheetMeta, snapshot: SheetSnapshot): string {
  const safeSummary = escapeHtml(meta.summary)
  const staleNote = snapshot.stale
    ? `<p class="sheet-stale">STALE: the live read failed; showing the cached snapshot from ` +
      `${escapeHtml(snapshot.readAt)}.</p>`
    : ''
  return (
    '<figure class="sheet">' +
    `<figcaption>${safeSummary}</figcaption>` +
    staleNote +
    htmlTableFor(snapshot.values) +
    `<p class="sheet-meta"><a href="${escapeHtml(sheetUrlFor(meta.id))}">Open in Google Sheets</a> ` +
    `&mdash; read ${escapeHtml(snapshot.readAt)}</p>` +
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
function transformCodeBlocks(doc: Doc, tree: Root, ctx: SiteEmitContext, rootPrefix: string): Replacement[] {
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
      markup = figureForDiagram(rootPrefix + path, meta.summary)
    } else if (node.lang === 'mermaid') {
      const id = assetIdForDiagram(node.value)
      const path = ctx.assetPaths[id]
      if (!path) throw new Error(`${where}: no rendered asset found for this mermaid diagram`)
      markup = `<img src="${escapeHtml(rootPrefix + path)}" loading="lazy" alt="Diagram">`
    } else if (node.lang === 'artifact') {
      const meta = parseArtifactMeta(node.meta, where)
      const id = assetIdForFile(meta.fallback)
      const path = ctx.assetPaths[id]
      if (!path) throw new Error(`${where}: no rendered asset found for ${meta.fallback}`)
      markup = figureForAsset(rootPrefix + path, meta.summary)
    } else if (node.lang === 'sheet') {
      const meta = parseSheetMeta(node.meta, where)
      const snapshot = getSnapshot(doc, meta.id, meta.range)
      if (!snapshot) {
        throw new Error(
          `${where}: no cached snapshot for spreadsheet ${meta.id} (range ${meta.range}). ` +
            'Run `contrail sheet pull` first.',
        )
      }
      markup = figureForSheet(meta, snapshot)
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

const SECTION_PATH_PATTERN = new RegExp(`(?:^|[\\\\/])(?:${SECTIONS.join('|')})(?:[\\\\/]|$)`)

/** Whether a resolved absolute path falls inside one of contrail's project
 * sections (`03-management`, ...) — regardless of whether the file at that
 * path is a `.md` document contrail actually tracks. */
function isSectionPath(absPath: string): boolean {
  return SECTION_PATH_PATTERN.test(absPath)
}

/**
 * A client-visible page must never carry a working — or readable — link to
 * a document this build excludes. `ctx.docs` covers every document contrail
 * knows about (not just the ones being emitted), so a link into an excluded
 * one is recognized even though that document's own page was never written.
 * The link is replaced by its own plain text: no href survives, because the
 * href alone (e.g. `03-management/budget.md`) is enough to leak that the
 * document exists.
 *
 * A link into a document that IS visible is rewritten to the correct
 * relative href for the (possibly nested) emitted output — the original
 * markdown-relative URL was written against the source tree, and once
 * sections emit into real directories it rarely still points at the right
 * place.
 *
 * `ctx.docs` only ever has entries for `.md` files matched by the
 * configured glob — a link to a non-`.md` file inside a section directory
 * (`03-management/budget.xlsx`) resolves to no entry at all. In a filtered
 * (audience) build, that absence is not "safe to leave alone": the rule is
 * "if I am not emitting it, I do not link to it", regardless of extension.
 */
function transformLinks(doc: Doc, tree: Root, ctx: SiteEmitContext): void {
  const fromPageFile = pageFileFor(doc.key)
  visit(tree, 'link', (node: Link, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return
    const target = resolveLinkTarget(doc, node.url)
    if (target === undefined) return
    const known = ctx.docs.get(target)

    const defang = known === undefined ? ctx.filtered && isSectionPath(target) : !known.visible
    if (defang) {
      ctx.defangedLinks.push({ doc: doc.key, url: node.url })
      const text: Text = { type: 'text', value: linkText(node) }
      parent.children.splice(index, 1, text)
      return
    }
    if (known === undefined) return // not a document contrail tracks: leave it exactly as written

    const withoutSuffix = node.url.split('#')[0]!.split('?')[0]!
    const suffix = node.url.slice(withoutSuffix.length)
    node.url = relativeHref(fromPageFile, known.pageFile) + suffix
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

function pageShell(title: string, body: string, rootPrefix: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${rootPrefix}site.css">
</head>
<body>
${body}
</body>
</html>
`
}

export function emitSite(doc: Doc, ctx: SiteEmitContext): string {
  const tree = structuredClone(doc.tree) as Root
  const rootPrefix = rootPrefixFor(pageFileFor(doc.key))
  transformLinks(doc, tree, ctx)
  const replacements = transformCodeBlocks(doc, tree, ctx, rootPrefix)
  replacements.push(...transformAlerts(tree))

  const processor = unified().use(remarkRehype).use(rehypeStringify)
  let bodyHtml = processor.stringify(processor.runSync(tree))
  for (const { placeholder, html } of replacements) {
    bodyHtml = bodyHtml.replace(`<p>${placeholder}</p>`, html)
  }

  const { title, summary, status } = doc.frontmatter
  const body = `<header class="page-header">
<p class="breadcrumb"><a href="${rootPrefix}index.html">&larr; All documents</a></p>
<h1>${escapeHtml(title)}</h1>
<p class="summary">${escapeHtml(summary)}</p>
<span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span>
</header>
<main>
${bodyHtml}
</main>`

  return pageShell(title, body, rootPrefix)
}

/** The five sections' human-readable titles, in numeric (display) order.
 * `00-meta` is deliberately absent — it is machine metadata, never a
 * document, and is excluded from the index entirely (see `emitIndex`). */
const SECTION_TITLES: Record<Exclude<Section, '00-meta'>, string> = {
  '01-overview': 'Overview & Initiation',
  '02-planning': 'Planning & Scope',
  '03-management': 'Management & Operations',
  '04-technical': 'Technical & Design',
  '05-delivery': 'Testing & Handover',
}

/** Title-cases a directory-name path segment for display: `"qa-reports"` ->
 * `"QA Reports"`, `"change-requests"` -> `"Change Requests"`. `qa` is the one
 * segment whose plain capitalize-first-letter title case is wrong — it is
 * an acronym. */
function titleCaseSegment(segment: string): string {
  return segment
    .split('-')
    .map((word) => (word.toLowerCase() === 'qa' ? 'QA' : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

/**
 * The section (and, when the document sits inside one, its immediate
 * sub-directory) a document belongs to — read from its own path, not
 * `frontmatter.section`, so the index groups by where a document actually
 * lives even when nobody has classified it. `undefined` means "not inside
 * one of the five sections" (grouped into "Other" by `emitIndex`); `00-meta`
 * is handled separately by `emitIndex` itself, since it is excluded outright
 * rather than folded into "Other".
 */
function sectionGroupFor(key: string): { section: Exclude<Section, '00-meta'>; sub?: string } | undefined {
  const segments = key.replace(/^docs\//, '').split('/')
  const top = segments[0]
  if (top === undefined || top === '00-meta' || !(SECTIONS as readonly string[]).includes(top)) return undefined
  const sub = segments.length > 2 ? segments[1] : undefined
  return { section: top as Exclude<Section, '00-meta'>, sub }
}

function docRow(doc: Doc): string {
  return `<li class="doc-entry">
<a href="${escapeHtml(pageFileFor(doc.key))}">${escapeHtml(doc.frontmatter.title)}</a>
<span class="status status-${escapeHtml(doc.frontmatter.status)}">${escapeHtml(doc.frontmatter.status)}</span>
<p>${escapeHtml(doc.frontmatter.summary)}</p>
</li>`
}

function docListHtml(docs: Doc[]): string {
  return `<ul class="doc-list">\n${docs.map(docRow).join('\n')}\n</ul>`
}

/**
 * The index groups documents by section, in numeric order, with nested
 * sub-directories (`03-management/meetings/`, ...) as nested groups under
 * their section rather than as siblings — the reader can then see where in
 * the five-section structure they are. Documents outside the five sections
 * appear last, under "Other"; `00-meta` documents (machine metadata, not
 * documentation) are excluded entirely.
 */
function emitIndex(docs: Doc[]): string {
  const bySection = new Map<Exclude<Section, '00-meta'>, { direct: Doc[]; subgroups: Map<string, Doc[]> }>()
  const other: Doc[] = []

  for (const doc of docs) {
    if (doc.key.replace(/^docs\//, '').split('/')[0] === '00-meta') continue

    const group = sectionGroupFor(doc.key)
    if (!group) {
      other.push(doc)
      continue
    }
    let entry = bySection.get(group.section)
    if (!entry) {
      entry = { direct: [], subgroups: new Map() }
      bySection.set(group.section, entry)
    }
    if (group.sub === undefined) {
      entry.direct.push(doc)
    } else {
      const list = entry.subgroups.get(group.sub) ?? []
      list.push(doc)
      entry.subgroups.set(group.sub, list)
    }
  }

  const sectionsHtml = (Object.keys(SECTION_TITLES) as Array<keyof typeof SECTION_TITLES>)
    .map((section) => {
      const entry = bySection.get(section)
      if (!entry) return ''
      const direct = entry.direct.length > 0 ? docListHtml(entry.direct) : ''
      const subgroups = [...entry.subgroups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([sub, list]) => `<h3>${escapeHtml(titleCaseSegment(sub))}</h3>\n${docListHtml(list)}`)
        .join('\n')
      return `<section class="doc-section">
<h2>${escapeHtml(SECTION_TITLES[section])}</h2>
${direct}
${subgroups}
</section>`
    })
    .filter((html) => html.length > 0)
    .join('\n')

  const otherHtml =
    other.length > 0
      ? `<section class="doc-section">
<h2>Other</h2>
${docListHtml(other)}
</section>`
      : ''

  const body = `<header class="page-header">
<h1>Documentation</h1>
</header>
<main>
${sectionsHtml}
${otherHtml}
</main>`

  return pageShell('Documentation', body, '')
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
  const docPages = new Map(
    docs.map((doc) => [
      resolve(doc.absPath),
      { pageFile: pageFileFor(doc.key), visible: emittedKeys.has(doc.key) },
    ] as const),
  )

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
  const ctx: SiteEmitContext = { diagramPaths, assetPaths, docs: docPages, filtered: audience !== undefined, defangedLinks }
  const pages: string[] = []
  for (const doc of emitted) {
    const pagePath = join(outDir, pageFileFor(doc.key))
    mkdirSync(dirname(pagePath), { recursive: true })
    writeFileSync(pagePath, emitSite(doc, ctx))
    pages.push(doc.key)
  }

  writeFileSync(join(outDir, 'index.html'), emitIndex(emitted))

  return { outDir, pages, diagrams: diagramCount, defangedLinks }
}
