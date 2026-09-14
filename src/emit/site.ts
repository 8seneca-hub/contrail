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
import { readProjectMeta } from '../config.js'
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
  /**
   * Whether this build is the internal one (everything, or an explicit
   * `audience: 'internal'`) as opposed to `audience: 'client'`. Drives the
   * build-identity banner and the `<title>` marker (Task 1) — the client
   * build's own emitted bytes must never contain the word "internal", so
   * every place that renders it checks this flag rather than `filtered`
   * (which is also true for, say, a hypothetical internal-only filter).
   */
  isInternal: boolean
  /** The project name from `docs/00-meta/project.yml`, when one exists — carried in every `<title>`
   * and as the index heading (Task 1). `undefined` for a tree without one; callers fall back. */
  projectName?: string
  /** This build's own deployed address (`site.internalUrl`/`site.clientUrl`), when configured — feeds
   * the canonical link tag on every page (Task 3). `undefined` keeps pages relative-link-only. */
  siteUrl?: string
  /** The whole visible-document tree (Task 5/6): the five sections plus a virtual "other" bucket at
   * the root, arbitrarily deep sub-directories under each. Drives every nav bar on every page — the
   * persistent top-level one and, for a document/page sitting inside a branching directory, one
   * more bar per level down to it (Task 6). Built once per build from the emitted documents. */
  tree: DirNode
}

/**
 * One directory's worth of the visible-document tree: the documents that live directly in it, and
 * its sub-directories (each itself a `DirNode`, recursively — arbitrary depth). The root `DirNode`
 * (see `buildSiteTree`) represents the whole build: its children are the five sections plus a
 * virtual `other` bucket for documents outside all five; it never has `docs` of its own.
 */
export interface DirNode {
  docs: Doc[]
  children: Map<string, DirNode>
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

/** Task 1's build-identity banner text. Rendered only on an internal build's pages (see
 * `bannerHtml`) — a client build must never contain this string, in this file or in `site.css`. */
const INTERNAL_NOTICE = 'Internal — contains commercial information. Not for client distribution.'

/**
 * The persistent build-identity banner (Task 1): present on every page of an internal build,
 * entirely absent from a client build — the absence is itself the signal, not a hidden element.
 * Its CSS class deliberately avoids the word "internal" so the one file shared by both audiences
 * (`site.css`) never carries that word into a client build's emitted bytes.
 */
function bannerHtml(ctx: SiteEmitContext): string {
  return ctx.isInternal ? `<div class="notice-banner" role="note">${escapeHtml(INTERNAL_NOTICE)}</div>\n` : ''
}

/** The virtual bucket for documents outside the five sections. Not a real `Section` — there is no
 * `other/` directory in the source tree — but it gets a real landing page (`other/index.html`) the
 * same way a real section does, so those documents stay reachable from the nav. */
const OTHER_KEY = 'other'
const OTHER_TITLE = 'Other'

/** The pseudo-tab key for "this directory's own documents", when a directory has both direct
 * documents and sub-directories (Task 6) — its landing page IS this tab's target. */
const OVERVIEW_KEY = 'overview'
const OVERVIEW_TITLE = 'Overview'

/** The five sections' human-readable titles, in numeric (display) order — the fixed order the
 * top-level nav always uses, `OTHER_KEY` last. Every other directory's children sort alphabetically
 * by title instead (see `orderedChildNames`) — there is no equivalent fixed convention below it. */
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

/** A directory name's tab label: a section keeps its human title, `OTHER_KEY` reads "Other",
 * anything else (an arbitrary-depth sub-folder) is title-cased from its own segment name. */
function titleForSegment(name: string): string {
  if (name === OTHER_KEY) return OTHER_TITLE
  if (name in SECTION_TITLES) return SECTION_TITLES[name as Exclude<Section, '00-meta'>]
  return titleCaseSegment(name)
}

function emptyDirNode(): DirNode {
  return { docs: [], children: new Map() }
}

/** The total number of documents a directory holds, including every descendant — what a tab's
 * count (Task 6: `Meetings 12`) shows, and what decides whether a directory has anything to link to
 * at all (an audience-filtered build must render no tab and no landing page for an empty one). */
function totalDocCount(node: DirNode): number {
  let total = node.docs.length
  for (const child of node.children.values()) total += totalDocCount(child)
  return total
}

/** Where a document sits in the site tree: the five real sections keep their own directory as the
 * first segment; anything else is bucketed under the virtual `other/` the same way `pageFileFor`
 * never creates a real `other/` directory in the *source* tree, only in this nav. Shared by
 * `buildSiteTree` (building the tree) and `emitSite` (finding a document's own place in it), so the
 * two can never disagree about where a document lives. */
function docDirSegments(key: string): string[] {
  const parts = key.replace(/^docs\//, '').split('/')
  parts.pop() // the filename itself is never a directory segment
  if (parts[0] !== undefined && (SECTIONS as readonly string[]).includes(parts[0])) return parts
  return [OTHER_KEY, ...parts]
}

/**
 * Builds the whole visible-document tree (Task 5/6) from a flat document list: `00-meta` documents
 * are machine metadata and never enter it; every other document is placed by `docDirSegments`,
 * arbitrarily deep. The root itself never carries direct documents — a document outside the five
 * sections goes into the virtual `other` child instead, so every "is this the site root, with no
 * `Overview` tab of its own" special case reduces to the ordinary "does this node have `docs`" check.
 */
function buildSiteTree(docs: Doc[]): DirNode {
  const root = emptyDirNode()
  for (const doc of docs) {
    if (doc.key.replace(/^docs\//, '').split('/')[0] === '00-meta') continue
    let node = root
    for (const segment of docDirSegments(doc.key)) {
      let child = node.children.get(segment)
      if (!child) {
        child = emptyDirNode()
        node.children.set(segment, child)
      }
      node = child
    }
    node.docs.push(doc)
  }
  return root
}

/**
 * FIX B: a sub-directory's own children (e.g. `03-management`'s `meetings`, `decisions`,
 * `change-requests`) are ordered by how often they are actually consulted, not alphabetically —
 * `Change Requests · Decisions · Meetings` reads as arbitrary because it is. Declared once, here, so
 * changing the priority never means hunting through the sort logic. `Overview` is not listed: it is
 * always first because it is a separate pseudo-tab pushed ahead of this list (see `tabBarHtml`), not
 * one of these named children. Anything not named here sorts alphabetically by title, after every
 * named entry.
 */
const SUB_TAB_PRIORITY: readonly string[] = ['meetings', 'decisions', 'change-requests', 'qa-reports', 'releases']

/** A node's child directory names worth showing, in display order: only those with at least one
 * document anywhere beneath them (Task 5, requirement 2 — an empty one gets no tab, no landing
 * page, not even in a full internal build, since it would still be empty there). The root uses the
 * five sections' fixed numeric order (`OTHER_KEY` last); every other node orders by
 * `SUB_TAB_PRIORITY` first, falling back to alphabetical by title for anything unlisted. */
function orderedChildNames(node: DirNode, isRoot: boolean): string[] {
  const present = [...node.children.keys()].filter((name) => totalDocCount(node.children.get(name)!) > 0)
  if (!isRoot) {
    return present.sort((a, b) => {
      const ai = SUB_TAB_PRIORITY.indexOf(a)
      const bi = SUB_TAB_PRIORITY.indexOf(b)
      if (ai === -1 && bi === -1) return titleForSegment(a).localeCompare(titleForSegment(b))
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  }

  const known = Object.keys(SECTION_TITLES) as string[]
  const ordered = known.filter((key) => present.includes(key))
  if (present.includes(OTHER_KEY)) ordered.push(OTHER_KEY)
  return ordered
}

/**
 * One tab bar (Task 5/6): plain links to `Overview` (this directory's own documents, when it has
 * any) and to each non-empty child directory's landing page, each carrying its document count
 * (`Meetings 12`). Not an ARIA tabs widget — real navigation to real pages needs no JavaScript,
 * which a `role="tab"` pattern would (arrow-key handling, panel toggling); the active link instead
 * carries `aria-current="page"`, the correct semantics for "you are here" navigation. Renders `''`
 * when there is nothing to show a tab for (a leaf directory, or an empty build).
 */
function tabBarHtml(node: DirNode, hrefPrefix: string, rootPrefix: string, activeKey: string, isRoot: boolean): string {
  const tabs: Array<{ key: string; title: string; count: number; href: string }> = []
  if (!isRoot && node.docs.length > 0) {
    tabs.push({ key: OVERVIEW_KEY, title: OVERVIEW_TITLE, count: node.docs.length, href: `${rootPrefix}${hrefPrefix}index.html` })
  }
  for (const name of orderedChildNames(node, isRoot)) {
    tabs.push({
      key: name,
      title: titleForSegment(name),
      count: totalDocCount(node.children.get(name)!),
      href: `${rootPrefix}${hrefPrefix}${name}/index.html`,
    })
  }
  if (tabs.length === 0) return ''

  const links = tabs
    .map(({ key, title, count, href }) => {
      const current = key === activeKey ? ' aria-current="page"' : ''
      return `<a href="${escapeHtml(href)}"${current}>${escapeHtml(title)} <span class="tab-count">${count}</span></a>`
    })
    .join('\n')
  const cls = isRoot ? 'section-nav' : 'section-nav sub-nav'
  return `<nav class="${cls}" aria-label="Documentation sections">\n${links}\n</nav>\n`
}

/**
 * Every nav bar for one page (Task 5/6): the persistent top-level bar, then one more bar per
 * directory level the page descends through that itself branches. Two callers, two different
 * `segments`:
 *
 * - A document page passes its own containing directory's segments (fixed — the document really
 *   does live there) with `autoExtend: false`: descent follows exactly that path and stops the
 *   instant it runs out, whether or not the directory it lands in has further children.
 * - A directory's own landing page passes its own segments with `autoExtend: true`: if the target
 *   directory has no direct documents of its own, descent keeps going into its first non-empty
 *   child (recursively) rather than stopping on a bar with nothing selected — the same "first
 *   non-empty section" rule the site root already used before Task 6, generalized to any depth.
 *
 * Returns the rendered bars and the `DirNode` whose own documents are the page's main content —
 * for a document page this return value is unused; for a landing page it is guaranteed to have at
 * least one document, since `autoExtend` only ever steps into a child with `totalDocCount > 0`.
 */
function renderNavStack(
  root: DirNode,
  segments: string[],
  rootPrefix: string,
  autoExtend: boolean,
): { barsHtml: string; contentNode: DirNode } {
  let node = root
  let hrefPrefix = ''
  let bars = ''
  let isRoot = true
  let i = 0

  for (;;) {
    let activeKey = segments[i]
    if (activeKey === undefined && autoExtend && node.docs.length === 0 && node.children.size > 0) {
      activeKey = orderedChildNames(node, isRoot)[0]
    }
    if (isRoot || node.children.size > 0) {
      bars += tabBarHtml(node, hrefPrefix, rootPrefix, activeKey ?? OVERVIEW_KEY, isRoot)
    }
    if (activeKey === undefined) break
    const child = node.children.get(activeKey)
    if (!child) break // a document's own path always exists in the tree it was built from
    node = child
    hrefPrefix = `${hrefPrefix}${activeKey}/`
    isRoot = false
    i++
  }

  return { barsHtml: bars, contentNode: node }
}

/**
 * Task 1's `<title>`: the project name (from `docs/00-meta/project.yml`) appended to `base`, with
 * an explicit `(internal)` marker on an internal build only — so two browser tabs never render the
 * same string. A tree with no `project.yml` falls back to `base` alone, same as before this work.
 */
function pageTitleFor(base: string, ctx: SiteEmitContext): string {
  const withProject = ctx.projectName ? `${base} · ${ctx.projectName}` : base
  // The marker never depends on `projectName` being configured — the two builds must stay
  // distinguishable even in a tree with no `docs/00-meta/project.yml` at all.
  return ctx.isInternal ? `${withProject} (internal)` : withProject
}

/** Task 1's `<title>` for the index and every section landing page: these pages' own heading
 * already IS the project name (or its section title) — unlike a document page, there is no
 * separate "base" title to join it to, so only the `(internal)` marker gets appended. */
function indexTitleFor(heading: string, ctx: SiteEmitContext): string {
  return ctx.isInternal ? `${heading} (internal)` : heading
}

/** Task 3's canonical URL for a page: absolute against this build's own configured address, or
 * `undefined` (no tag emitted) when none is configured — relative-link builds stay fully supported. */
function canonicalFor(ctx: SiteEmitContext, pageFile: string): string | undefined {
  return ctx.siteUrl ? `${ctx.siteUrl}/${pageFile}` : undefined
}

/** Task 1's theme bridge: the Docs tab renders this bundle in a sandboxed iframe on an opaque
 * origin, so the page cannot read Plane's theme via `postMessage` or storage — Plane passes it as
 * `?theme=dark|light` instead. The second half forwards the same parameter to nested diagram
 * iframes so a page and its diagrams never disagree; without it both fall back to
 * `prefers-color-scheme` and mismatch whenever the reader's Plane theme differs from their OS. */
const THEME_SCRIPT = `<script>(function(){var t=new URLSearchParams(location.search).get("theme");
if(t!=="dark"&&t!=="light")return;
document.documentElement.setAttribute("data-theme",t);
addEventListener("DOMContentLoaded",function(){
document.querySelectorAll("iframe[src]").forEach(function(f){
var u=new URL(f.getAttribute("src"),location.href);
u.searchParams.set("theme",t);
f.setAttribute("src",u.pathname+u.search);});});})();</script>`

function pageShell(title: string, body: string, rootPrefix: string, canonicalUrl?: string): string {
  const canonicalTag = canonicalUrl ? `\n<link rel="canonical" href="${escapeHtml(canonicalUrl)}">` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${rootPrefix}site.css">${canonicalTag}
${THEME_SCRIPT}
</head>
<body>
${body}
</body>
</html>
`
}

export function emitSite(doc: Doc, ctx: SiteEmitContext): string {
  const tree = structuredClone(doc.tree) as Root
  const pageFile = pageFileFor(doc.key)
  const rootPrefix = rootPrefixFor(pageFile)
  transformLinks(doc, tree, ctx)
  const replacements = transformCodeBlocks(doc, tree, ctx, rootPrefix)
  replacements.push(...transformAlerts(tree))

  const processor = unified().use(remarkRehype).use(rehypeStringify)
  let bodyHtml = processor.stringify(processor.runSync(tree))
  for (const { placeholder, html } of replacements) {
    bodyHtml = bodyHtml.replace(`<p>${placeholder}</p>`, html)
  }

  const { title, summary, status } = doc.frontmatter
  const { barsHtml } = renderNavStack(ctx.tree, docDirSegments(doc.key), rootPrefix, false)
  const body = `${bannerHtml(ctx)}${barsHtml}<header class="page-header">
<p class="breadcrumb"><a href="${rootPrefix}index.html">&larr; All documents</a></p>
<h1>${escapeHtml(title)}</h1>
<p class="summary">${escapeHtml(summary)}</p>
<span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span>
</header>
<main>
${bodyHtml}
</main>`

  return pageShell(pageTitleFor(title, ctx), body, rootPrefix, canonicalFor(ctx, pageFile))
}

/** The five sections' human-readable titles, in numeric (display) order.
 * `00-meta` is deliberately absent — it is machine metadata, never a
 * document, and is excluded from the index entirely (see `emitIndex`). */
/** A relative href from the page currently being rendered (`fromPageFile`) to a document's own
 * page — never the bare root-relative `pageFileFor`, because this markup is shared across every
 * depth of landing page: the same document needs a different href depending on where it is being
 * listed from. */
function docRow(doc: Doc, fromPageFile: string): string {
  const href = relativeHref(fromPageFile, pageFileFor(doc.key))
  return `<li class="doc-entry">
<a href="${escapeHtml(href)}">${escapeHtml(doc.frontmatter.title)}</a>
<span class="status status-${escapeHtml(doc.frontmatter.status)}">${escapeHtml(doc.frontmatter.status)}</span>
<p>${escapeHtml(doc.frontmatter.summary)}</p>
</li>`
}

function docListHtml(docs: Doc[], fromPageFile: string): string {
  return `<ul class="doc-list">\n${docs.map((doc) => docRow(doc, fromPageFile)).join('\n')}\n</ul>`
}

/** Task 6's three ordering rules, detected from the filename the author actually chose — never
 * from `docKind`, which is a taxonomy guess. Checked in this order because a date-prefixed name
 * (`2026-08-11-...`) would otherwise also match the more permissive number-prefix pattern. */
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})-/
const NUMBER_PREFIX = /^(\d+)-/

interface ClassifiedDoc {
  doc: Doc
  kind: 'date' | 'number' | 'alpha'
  /** `kind: 'date'` → the `YYYY-MM-DD` prefix; `kind: 'number'` → the parsed leading number;
   * `kind: 'alpha'` → the document's own title. Whatever `orderLeaf` sorts this group by. */
  sortKey: string | number
}

function classifyDoc(doc: Doc): ClassifiedDoc {
  const filename = doc.key.split('/').pop()!
  const dateMatch = DATE_PREFIX.exec(filename)
  if (dateMatch) return { doc, kind: 'date', sortKey: dateMatch[1]! }
  const numberMatch = NUMBER_PREFIX.exec(filename)
  if (numberMatch) return { doc, kind: 'number', sortKey: Number(numberMatch[1]) }
  return { doc, kind: 'alpha', sortKey: doc.frontmatter.title }
}

/**
 * Orders one leaf list of documents (Task 6): date-prefixed files newest first (you want this
 * week's meeting, not the kickoff from six months ago), number-prefixed files ascending (ADR 0001
 * is the foundation the rest build on), everything else alphabetically by title. A folder that
 * mixes patterns — rare in practice, since a folder's own convention tends to be uniform — renders
 * each group in that fixed order (dates, then numbers, then everything else) rather than
 * interleaving them, so the ordering within each group stays meaningful instead of arbitrary.
 */
function orderLeaf(docs: Doc[]): ClassifiedDoc[] {
  const classified = docs.map(classifyDoc)
  const dates = classified.filter((c): c is ClassifiedDoc & { sortKey: string } => c.kind === 'date')
  const numbers = classified.filter((c): c is ClassifiedDoc & { sortKey: number } => c.kind === 'number')
  const alphas = classified.filter((c): c is ClassifiedDoc & { sortKey: string } => c.kind === 'alpha')

  dates.sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  numbers.sort((a, b) => a.sortKey - b.sortKey)
  alphas.sort((a, b) => a.sortKey.localeCompare(b.sortKey))

  return [...dates, ...numbers, ...alphas]
}

/** Above this many documents, a date-prefixed run groups by year for scanning (Task 6) — below it,
 * one flat list is still easy to read in one pass. */
const YEAR_GROUP_THRESHOLD = 25

/**
 * Buckets an already newest-first `dates` list by its `YYYY` year, newest year first. Insertion
 * order alone gives that: the input is already sorted newest-first, so the first time a year is
 * seen is always its most recent document, and a `Map` preserves the order keys were first added.
 */
function groupDatesByYear(dates: Array<ClassifiedDoc & { sortKey: string }>): Array<[string, Doc[]]> {
  const byYear = new Map<string, Doc[]>()
  for (const { doc, sortKey } of dates) {
    const year = sortKey.slice(0, 4)
    const list = byYear.get(year) ?? []
    list.push(doc)
    byYear.set(year, list)
  }
  return [...byYear.entries()]
}

/**
 * Renders one leaf document list (Task 6): ordered per `orderLeaf`, and — only past
 * `YEAR_GROUP_THRESHOLD` documents, and only for the date-prefixed portion — grouped under `<h3>`
 * year headings. Grouping is for scanning, never for hiding: every document still renders, nothing
 * collapses behind a click. Any number-prefixed or alphabetical documents in the same over-threshold
 * folder still render, just after the year groups and still ungrouped — Task 6 groups "date-prefixed
 * documents" specifically, not every long list regardless of its ordering rule.
 */
function leafListHtml(docs: Doc[], fromPageFile: string): string {
  if (docs.length === 0) return ''
  const ordered = orderLeaf(docs)

  if (docs.length > YEAR_GROUP_THRESHOLD) {
    const dates = ordered.filter((c): c is ClassifiedDoc & { sortKey: string } => c.kind === 'date')
    if (dates.length > 0) {
      const rest = ordered.filter((c) => c.kind !== 'date').map((c) => c.doc)
      const yearHtml = groupDatesByYear(dates)
        .map(([year, list]) => `<h3>${escapeHtml(year)}</h3>\n${docListHtml(list, fromPageFile)}`)
        .join('\n')
      const restHtml = rest.length > 0 ? docListHtml(rest, fromPageFile) : ''
      return [yearHtml, restHtml].filter((html) => html.length > 0).join('\n')
    }
  }

  return docListHtml(
    ordered.map((c) => c.doc),
    fromPageFile,
  )
}

/**
 * The site root: Task 1's heading (the project name, not the generic "Documentation") over Task
 * 5/6's tabbed view — the top-level nav, any nested bars the default path descends through, and
 * that path's own document list. A build with nothing to show (an empty client build) still
 * renders the banner/heading shell, just with no nav and no document list.
 */
function emitIndex(ctx: SiteEmitContext): string {
  const heading = ctx.projectName ?? 'Documentation'
  const { barsHtml, contentNode } = renderNavStack(ctx.tree, [], '', true)
  const mainHtml = leafListHtml(contentNode.docs, 'index.html')

  const body = `${bannerHtml(ctx)}${barsHtml}<header class="page-header">
<h1>${escapeHtml(heading)}</h1>
</header>
<main>
${mainHtml}
</main>`

  return pageShell(indexTitleFor(heading, ctx), body, '', canonicalFor(ctx, 'index.html'))
}

/**
 * Any other directory's own landing page (Task 5/6) — a section (`03-management/index.html`), or
 * an arbitrarily deep sub-folder within one (`03-management/meetings/index.html`) — reachable
 * directly and from the nav bar on every other page in its own subtree.
 */
function emitLandingPage(ctx: SiteEmitContext, segments: string[]): string {
  const pageFile = `${segments.join('/')}/index.html`
  const rootPrefix = rootPrefixFor(pageFile)
  const { barsHtml, contentNode } = renderNavStack(ctx.tree, segments, rootPrefix, true)
  const mainHtml = leafListHtml(contentNode.docs, pageFile)
  const title = titleForSegment(segments[segments.length - 1]!)

  const body = `${bannerHtml(ctx)}${barsHtml}<header class="page-header">
<p class="breadcrumb"><a href="${rootPrefix}index.html">&larr; All documents</a></p>
</header>
<main>
${mainHtml}
</main>`

  return pageShell(pageTitleFor(title, ctx), body, rootPrefix, canonicalFor(ctx, pageFile))
}

/** Every document contrail knows about that would be published for the given audience filter.
 * `undefined` (no `--audience` flag) publishes everything — the audience gate is strictly opt-in. */
export function docsForAudience(docs: Doc[], audience: Audience | undefined): Doc[] {
  if (audience === undefined) return docs
  return docs.filter((doc) => doc.frontmatter.audience === audience)
}

/**
 * FIX C: a directory's own scaffolded `README.md` (`INDEX_STUBS` in scaffold.ts) exists to explain
 * what belongs in the folder — it is not a document in its own right. Excluded from the site build
 * entirely so it never inflates a tab's count or shows up in a directory's document listing; the
 * source file itself is untouched on disk, which is all `init` ever promised it.
 */
function isDirectoryReadme(doc: Doc): boolean {
  return doc.key.split('/').pop() === 'README.md'
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
  /** The project name from `docs/00-meta/project.yml` (Task 1) — `undefined` for a tree without
   * one, in which case every page falls back to its pre-M3 title/heading. */
  projectName?: string
  /** This build's own deployed address (Task 3) — `site.internalUrl` for an internal build,
   * `site.clientUrl` for a client one. `undefined` keeps every page's links relative. */
  siteUrl?: string
}): Promise<SiteResult> {
  const { docs, outDir, cacheDir, mmdc, archify, audience, projectName, siteUrl } = args
  const emitted = docsForAudience(docs, audience).filter((doc) => !isDirectoryReadme(doc))
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
  const tree = buildSiteTree(emitted)
  const ctx: SiteEmitContext = {
    diagramPaths,
    assetPaths,
    docs: docPages,
    filtered: audience !== undefined,
    defangedLinks,
    // Only an explicit `audience: 'client'` build (the only other value the type allows) omits the
    // banner and drops the "(internal)" title marker — the default (everything) build is internal.
    isInternal: audience !== 'client',
    projectName,
    siteUrl,
    tree,
  }
  const pages: string[] = []
  for (const doc of emitted) {
    const pagePath = join(outDir, pageFileFor(doc.key))
    mkdirSync(dirname(pagePath), { recursive: true })
    writeFileSync(pagePath, emitSite(doc, ctx))
    pages.push(doc.key)
  }

  writeFileSync(join(outDir, 'index.html'), emitIndex(ctx))

  // Task 5/6: one landing page per non-empty directory in the tree, at every depth, so the nav on
  // every other page has somewhere real to point — recursing depth-first skips any (sub-)directory
  // with no visible document at all in this build (Task 5, requirement 2: no tab, no landing page).
  const writeLandingPages = (node: DirNode, segments: string[]): void => {
    for (const [name, child] of node.children) {
      if (totalDocCount(child) === 0) continue
      const childSegments = [...segments, name]
      const dir = join(outDir, ...childSegments)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'index.html'), emitLandingPage(ctx, childSegments))
      writeLandingPages(child, childSegments)
    }
  }
  writeLandingPages(tree, [])

  return { outDir, pages, diagrams: diagramCount, defangedLinks }
}
