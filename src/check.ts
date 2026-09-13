import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { visit } from 'unist-util-visit'
import type { Heading, List, Root, RootContent, Text } from 'mdast'
import { parseAttrs } from './blocks/attrs.js'
import { readProjectMeta } from './config.js'
import { DOC_KIND_SECTION, SECTIONS, type DocKind, type Section } from './doc-kinds.js'
import { CORE_DOC_KINDS } from './scaffold.js'
import type { Config, Doc } from './types.js'

export interface Finding {
  doc: string
  line?: number
  rule: string
  message: string
  severity: 'warn' | 'error'
}

const FLOW_HEADING = /flow|lifecycle|sequence|architecture|pipeline|process|journey|state/i
const EXPLANATION_HEADING = /why|background|rationale|design note/i
const RELATIVE_TIME = /\brecently\b|\bcurrently\b|\bthe current version\b|\bas of now\b/i
const DANGLING_REFERENCE = /\bas (?:mentioned|described|shown) above\b|\bsee below\b/i

/**
 * A "money path": the conventional home of budget/estimate documents, or a
 * path segment named for one. Matched independently of `docKind` because a
 * document can sit under a money path without ever having been classified
 * at all — that is exactly the silent case `unclassified-money-doc` exists
 * to catch.
 */
const MONEY_PATH_PATTERNS = [/03-management\/budget(?:\/|\.|$)/, /(?:^|\/)estimate(?:\/|\.|$)/i]

function isMoneyPath(key: string): boolean {
  return MONEY_PATH_PATTERNS.some((re) => re.test(key))
}

/**
 * Whether a document is money-sensitive: its `docKind` is `budget` or
 * `estimate`, or it lives under a money path. Either is sufficient — a
 * budget file misfiled outside `03-management/budget` is still a budget
 * file, and a file sitting in a money path with no `docKind` set yet is
 * still worth protecting.
 */
function isMoneyDoc(doc: Doc): boolean {
  const kind = doc.frontmatter.docKind
  return kind === 'budget' || kind === 'estimate' || isMoneyPath(doc.key)
}

function isDiagramCode(node: RootContent): boolean {
  return node.type === 'code' && (node.lang === 'archify' || node.lang === 'mermaid')
}

/** Any node range treated as a detached root for a `visit`-based scan. */
function containsDiagram(nodes: RootContent[]): boolean {
  let found = false
  visit({ type: 'root', children: nodes } as Root, 'code', (node) => {
    if (isDiagramCode(node)) found = true
  })
  return found
}

function headingText(node: Heading): string {
  let text = ''
  visit(node, 'text', (t: Text) => {
    text += t.value
  })
  return text
}

/** Names which of the five Archify types fits the heading's own wording, so a
 * finding never just says "add a diagram". */
function suggestArchifyType(heading: string): string {
  if (/lifecycle|state/i.test(heading)) return 'lifecycle'
  if (/architecture|pipeline/i.test(heading)) return 'architecture'
  if (/sequence/i.test(heading)) return 'sequence'
  return 'workflow or sequence'
}

/** The heading section a top-level node at `index` belongs to: from just
 * after the nearest preceding heading (any depth) to the next heading whose
 * depth is <= that heading's — i.e. the whole subtree, sub-headings
 * included, so a diagram nested under a sub-heading still counts as
 * covering the section. With no preceding heading, the "section" is the
 * whole document. */
function ownerSection(
  children: RootContent[],
  index: number,
): { start: number; end: number; heading?: Heading } {
  let ownerIndex = -1
  for (let j = index - 1; j >= 0; j--) {
    if (children[j]!.type === 'heading') {
      ownerIndex = j
      break
    }
  }
  if (ownerIndex === -1) return { start: 0, end: children.length }

  const heading = children[ownerIndex] as Heading
  let end = children.length
  for (let j = ownerIndex + 1; j < children.length; j++) {
    const next = children[j]!
    if (next.type === 'heading' && (next as Heading).depth <= heading.depth) {
      end = j
      break
    }
  }
  return { start: ownerIndex + 1, end, heading }
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

function checkFlowWithoutDiagram(doc: Doc, children: RootContent[], findings: Finding[]): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!
    if (node.type !== 'heading') continue
    const text = headingText(node)
    if (!FLOW_HEADING.test(text)) continue

    let end = children.length
    for (let j = i + 1; j < children.length; j++) {
      const next = children[j]!
      if (next.type === 'heading' && (next as Heading).depth <= node.depth) {
        end = j
        break
      }
    }
    if (containsDiagram(children.slice(i + 1, end))) continue

    findings.push({
      doc: doc.key,
      line: node.position?.start.line,
      rule: 'flow-without-diagram',
      severity: 'warn',
      message:
        `Section '${text}' describes a flow with no diagram — add an \`archify\` block ` +
        `(type=${suggestArchifyType(text)}).`,
    })
  }
}

function checkStepsWithoutDiagram(doc: Doc, children: RootContent[], findings: Finding[]): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!
    if (node.type !== 'list') continue
    const list = node as List
    if (!list.ordered || list.children.length < 4) continue

    const { start, end, heading } = ownerSection(children, i)
    if (containsDiagram(children.slice(start, end))) continue

    const label = heading ? `'${headingText(heading)}'` : 'the top of the document'
    findings.push({
      doc: doc.key,
      line: node.position?.start.line,
      rule: 'steps-without-diagram',
      severity: 'warn',
      message:
        `Section ${label} lists ${list.children.length} ordered steps with no diagram — add an ` +
        '`archify` block (type=workflow).',
    })
  }
}

function checkUndiagrammedDoc(doc: Doc, findings: Finding[]): void {
  if (containsDiagram(doc.tree.children)) return
  const words = wordCount(doc.body)
  if (words <= 400) return

  findings.push({
    doc: doc.key,
    rule: 'undiagrammed-doc',
    severity: 'warn',
    message:
      `This document is ${words} words with no diagram at all — describe its shape with an ` +
      '`archify` block (architecture, workflow, sequence, dataflow, or lifecycle — pick the type that fits).',
  })
}

function checkMissingSummary(doc: Doc, findings: Finding[]): void {
  visit(doc.tree, 'code', (node) => {
    if (node.lang !== 'archify') return
    const attrs = parseAttrs(node.meta ?? '')
    if (attrs.summary) return

    findings.push({
      doc: doc.key,
      line: node.position?.start.line,
      rule: 'missing-summary',
      severity: 'error',
      message:
        `Archify block${attrs.type ? ` (type=${attrs.type})` : ''} is missing \`summary\` — every ` +
        'diagram must carry a summary a reader can understand without seeing the picture.',
    })
  })
}

function checkStaleDoc(doc: Doc, findings: Finding[]): void {
  if (doc.frontmatter.status !== 'stale') return
  findings.push({
    doc: doc.key,
    rule: 'stale-doc',
    severity: 'warn',
    message:
      'This document is marked `status: stale` — verify and update its content, or remove it if it no ' +
      'longer applies.',
  })
}

function checkMixedMode(doc: Doc, findings: Finding[]): void {
  const kind = doc.frontmatter.kind
  if (!kind) return

  if (kind === 'how-to' || kind === 'reference') {
    visit(doc.tree, 'heading', (node: Heading) => {
      const text = headingText(node)
      if (!EXPLANATION_HEADING.test(text)) return
      findings.push({
        doc: doc.key,
        line: node.position?.start.line,
        rule: 'mixed-mode',
        severity: 'warn',
        message:
          `Section '${text}' reads like explanation inside a \`kind: ${kind}\` document — move the ` +
          'rationale to a separate explanation document; mixing Diátaxis modes serves neither reader.',
      })
    })
  } else if (kind === 'explanation') {
    visit(doc.tree, 'list', (node: List) => {
      if (!node.ordered) return
      findings.push({
        doc: doc.key,
        line: node.position?.start.line,
        rule: 'mixed-mode',
        severity: 'warn',
        message:
          'This `kind: explanation` document contains numbered steps — move step-by-step instructions ' +
          'to a how-to document.',
      })
    })
  }
}

function checkProseHygiene(doc: Doc, findings: Finding[]): void {
  visit(doc.tree, 'text', (node: Text) => {
    const relativeTime = node.value.match(RELATIVE_TIME)
    if (relativeTime) {
      findings.push({
        doc: doc.key,
        line: node.position?.start.line,
        rule: 'relative-time',
        severity: 'warn',
        message:
          `Found relative time language ("${relativeTime[0]}") — replace it with an absolute date or ` +
          'version (e.g. "2026-09-12" or "v1.4.0"); it rots silently otherwise.',
      })
    }

    const dangling = node.value.match(DANGLING_REFERENCE)
    if (dangling) {
      findings.push({
        doc: doc.key,
        line: node.position?.start.line,
        rule: 'dangling-reference',
        severity: 'warn',
        message:
          `Found a dangling reference ("${dangling[0]}") — name the section or link to it directly; an ` +
          'agent handed one fragment cannot see "above" or "below".',
      })
    }
  })
}

/**
 * The audience boundary, part one: a money document explicitly opted into
 * `audience: client` would be published straight to the client. This is an
 * error, not a warning — a lint tool that only nags about a leaked margin
 * is not doing its job.
 */
function checkInternalDocExposed(doc: Doc, findings: Finding[]): void {
  if (!isMoneyDoc(doc)) return
  if (doc.frontmatter.audience !== 'client') return

  findings.push({
    doc: doc.key,
    rule: 'internal-doc-exposed',
    severity: 'error',
    message:
      'This document is money-sensitive ' +
      `(docKind '${doc.frontmatter.docKind ?? 'n/a'}', path '${doc.key}') but is marked ` +
      '`audience: client` — a client build would publish it. Remove `audience: client` or move it out ' +
      'of a money path.',
  })
}

/**
 * The audience boundary, part two: the `internal` default already protects
 * an unclassified money document from ever reaching a client build. The
 * point of this rule is that the silence itself is a problem — nobody
 * should be able to point at a budget file and honestly say "I never
 * thought about who could see this."
 */
function checkUnclassifiedMoneyDoc(doc: Doc, findings: Finding[]): void {
  if (!isMoneyDoc(doc)) return
  if (doc.audienceExplicit) return

  findings.push({
    doc: doc.key,
    rule: 'unclassified-money-doc',
    severity: 'error',
    message:
      'This document is money-sensitive but has no explicit `audience` in its frontmatter. The default ' +
      'keeps it internal, but silence on a money document must be loud — add `audience: internal` ' +
      'explicitly (or `audience: client` if that is truly intended).',
  })
}

/**
 * Whether a document is still shaped like a freshly scaffolded stub: the
 * placeholder body `renderDocFile`/`renderIndexStub` (scaffold.ts) write —
 * a heading or two and a bullet list of guiding questions/notes, no prose.
 * Read directly off that shape (a bullet list, no paragraph anywhere) rather
 * than a word-count guess, so it stops matching the instant a document gets
 * its first real paragraph. Deliberately keyed on an UNORDERED list only —
 * an ordered list of real numbered steps (which `steps-without-diagram`
 * exists to catch) must never be mistaken for a stub.
 */
export function isStub(doc: Doc): boolean {
  const hasParagraph = doc.tree.children.some((n) => n.type === 'paragraph')
  const hasBulletList = doc.tree.children.some((n) => n.type === 'list' && !(n as List).ordered)
  return hasBulletList && !hasParagraph
}

/**
 * The section a document's path places it under — read from the path itself
 * (any segment matching a known section name), never from frontmatter. This
 * is what `orphan-doc` and `missing-core-doc` mean by "a section exists":
 * documents actually sitting in that folder, not a metadata claim a document
 * could make about itself from anywhere.
 */
const SECTION_SEGMENT = new RegExp(`(?:^|/)(${SECTIONS.join('|')})(?:/|$)`)

export function pathSection(key: string): Section | undefined {
  const match = key.match(SECTION_SEGMENT)
  return match ? (match[1] as Section) : undefined
}

/**
 * A stub is not a problem by itself — a fresh `init --template` is nothing
 * BUT stubs, and that must lint clean. It becomes worth a warning only once
 * someone has promoted it past `draft` (review/current/stale) while the body
 * is still just the placeholder — a claim of progress the content doesn't
 * back up. This is also the ONE report a stub gets: the six content rules
 * above all skip a stub outright (see `checkDocs`), so a stub is never
 * double-reported.
 */
function checkEmptyStub(doc: Doc, findings: Finding[]): void {
  if (!isStub(doc)) return
  if (doc.frontmatter.status === 'draft') return
  findings.push({
    doc: doc.key,
    rule: 'empty-stub',
    severity: 'warn',
    message:
      `This document is marked \`status: ${doc.frontmatter.status}\` but still has only its scaffolded ` +
      'placeholder content (guiding questions/notes, no prose) — fill it in, or move it back to `status: draft`.',
  })
}

/** A document living inside a folder that names none of the six sections is
 * outside the taxonomy the rest of the tool assumes. A document with no
 * folder at all (a bare filename) has no placement to judge, so it is left
 * alone — this rule is about a document that IS nested, just nested wrong. */
function checkOrphanDoc(doc: Doc, findings: Finding[]): void {
  if (!doc.key.includes('/')) return
  if (pathSection(doc.key) !== undefined) return
  findings.push({
    doc: doc.key,
    rule: 'orphan-doc',
    severity: 'warn',
    message: `This document sits outside the section folders (${SECTIONS.join(', ')}) — move it under one of them.`,
  })
}

/**
 * "A section exists" means documents are actually filed there — read from
 * the path, same as `orphan-doc`. Reported against the section name itself
 * (there is no single offending document; the finding is an absence), one
 * per missing core docKind, so a project missing several core docs gets
 * several specific, actionable lines rather than one vague one.
 */
function checkMissingCoreDoc(docs: Doc[], findings: Finding[]): void {
  const sectionsPresent = new Set<Section>()
  const kindsBySection = new Map<Section, Set<DocKind>>()

  for (const doc of docs) {
    const section = pathSection(doc.key)
    if (!section) continue
    sectionsPresent.add(section)
    const kind = doc.frontmatter.docKind
    if (!kind) continue
    const set = kindsBySection.get(section) ?? new Set<DocKind>()
    set.add(kind)
    kindsBySection.set(section, set)
  }

  for (const section of sectionsPresent) {
    const have = kindsBySection.get(section) ?? new Set<DocKind>()
    for (const kind of CORE_DOC_KINDS) {
      if (DOC_KIND_SECTION[kind] !== section) continue
      if (have.has(kind)) continue
      findings.push({
        doc: section,
        rule: 'missing-core-doc',
        severity: 'warn',
        message: `Section '${section}' has documents but no '${kind}' — scaffold one: \`contrail scaffold ${kind} docs/${section}/<name>.md\`.`,
      })
    }
  }
}

/**
 * Ownership is not expected of an untouched draft — nobody has claimed it
 * yet, and that is fine. It starts to matter once a document moves past
 * `draft`: something is now review-worthy or in force, and it needs a name
 * attached to keeping it accurate.
 */
function checkNoOwner(doc: Doc, findings: Finding[]): void {
  if (doc.frontmatter.status === 'draft') return
  if (doc.frontmatter.owner) return
  findings.push({
    doc: doc.key,
    rule: 'no-owner',
    severity: 'warn',
    message: 'This document has no `owner` — add one so there is a name attached to keeping it accurate.',
  })
}

const REVIEW_WINDOW_DAYS = 90
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Two ways to be unreviewed: a `current` document that has never been
 * reviewed at all (no `reviewedOn`), or one whose last review has aged out
 * of the 90-day window regardless of status. A malformed `reviewedOn` is not
 * this rule's problem — it stays silent rather than guess.
 */
function checkUnreviewed(doc: Doc, findings: Finding[]): void {
  const { reviewedOn, status } = doc.frontmatter
  if (!reviewedOn) {
    if (status !== 'current') return
    findings.push({
      doc: doc.key,
      rule: 'unreviewed',
      severity: 'warn',
      message: 'This `status: current` document has no `reviewedOn` date — add one once it has actually been reviewed.',
    })
    return
  }

  const reviewedAt = new Date(reviewedOn)
  if (Number.isNaN(reviewedAt.getTime())) return
  const ageDays = Math.floor((Date.now() - reviewedAt.getTime()) / MS_PER_DAY)
  if (ageDays <= REVIEW_WINDOW_DAYS) return

  findings.push({
    doc: doc.key,
    rule: 'unreviewed',
    severity: 'warn',
    message:
      `This document was last reviewed ${ageDays} days ago (${reviewedOn}), more than the ` +
      `${REVIEW_WINDOW_DAYS}-day window — review it again and update \`reviewedOn\`.`,
  })
}

export function checkDocs(docs: Doc[], _opts: { strict?: boolean } = {}): Finding[] {
  const findings: Finding[] = []

  for (const doc of docs) {
    const children = doc.tree.children
    // A stub reads as "empty" to every content rule below purely because of
    // its heading text or short body — that is a lint flaw, not a real
    // finding. `empty-stub` is the one report a stub can earn; see it above.
    if (!isStub(doc)) {
      checkFlowWithoutDiagram(doc, children, findings)
      checkStepsWithoutDiagram(doc, children, findings)
      checkUndiagrammedDoc(doc, findings)
      checkMixedMode(doc, findings)
      checkProseHygiene(doc, findings)
    }
    checkMissingSummary(doc, findings)
    checkStaleDoc(doc, findings)
    checkInternalDocExposed(doc, findings)
    checkUnclassifiedMoneyDoc(doc, findings)
    checkEmptyStub(doc, findings)
    checkOrphanDoc(doc, findings)
    checkNoOwner(doc, findings)
    checkUnreviewed(doc, findings)
  }
  checkMissingCoreDoc(docs, findings)

  return findings
}

export interface DocStatusReport {
  /** Every document currently shaped like a stub, regardless of `status`. */
  stubs: string[]
  /** Every document with no `owner`, regardless of `status`. */
  noOwner: string[]
  /** Document keys `unreviewed` fired on. */
  overdue: string[]
  /** `missing-core-doc` findings, one per absent core docKind. */
  missingCoreDocs: Finding[]
}

/**
 * `contrail status`'s documentation view: what state the documentation
 * itself is in — never a read on the project it describes. `noOwner` and
 * `stubs` report the raw fact for every document regardless of `status`
 * (status view is not gated the way the lint warning is); `overdue` reuses
 * `unreviewed`'s own date logic via `checkDocs` rather than a second copy of it.
 */
export function docStatusReport(docs: Doc[]): DocStatusReport {
  const findings = checkDocs(docs)
  return {
    stubs: docs.filter((doc) => isStub(doc)).map((doc) => doc.key),
    noOwner: docs.filter((doc) => !doc.frontmatter.owner).map((doc) => doc.key),
    overdue: findings.filter((f) => f.rule === 'unreviewed').map((f) => f.doc),
    missingCoreDocs: findings.filter((f) => f.rule === 'missing-core-doc'),
  }
}

/**
 * Errors are real broken invariants (a diagram with no summary) and fail a
 * build regardless of `--strict`. Warnings are guidance, never a build gate,
 * unless `--strict` opts in for CI — documentation tooling that blocks a
 * commit over a missing picture trains people to bypass the tool.
 */
export function checkExitCode(findings: Finding[], strict: boolean): number {
  if (findings.some((f) => f.severity === 'error')) return 1
  if (strict && findings.length > 0) return 1
  return 0
}

const KIND_ORDER: Array<{ kind: string; label: string }> = [
  { kind: 'tutorial', label: 'Tutorial' },
  { kind: 'how-to', label: 'How-to' },
  { kind: 'reference', label: 'Reference' },
  { kind: 'explanation', label: 'Explanation' },
]

export function llmsTxtPath(config: Config): string {
  return join(config.root, 'docs', 'llms.txt')
}

/**
 * `docs/llms.txt` in the llms.txt v2 convention: an H1, a one-line blockquote
 * summary, then every document as `- [Title](path): summary`, grouped by
 * `kind`. Replaces the bespoke INDEX.md M1 proposed — a convention agents
 * already understand beats a private format.
 */
export interface BuildLlmsTxtOptions {
  /**
   * Resolves a document to the link path used in its `llms.txt` entry.
   * Defaults to a path relative to `docs/llms.txt` — right for the
   * agent-facing tree written by `writeLlmsTxt`. `contrail site` passes one
   * that points at the emitted page instead, so the copy it writes into the
   * site output links to files that actually exist there.
   */
  linkFor?: (doc: Doc) => string
}

/**
 * The `llms.txt` title: the project name from `docs/00-meta/project.yml`
 * when one exists, else the workspace directory name. Never the Plane
 * `workspace` slug — that is an internal system identifier, and this is
 * the one build that must never leak internal material.
 */
function llmsTxtTitle(config: Config): string {
  return readProjectMeta(config.root)?.project ?? basename(config.root)
}

export function buildLlmsTxt(config: Config, docs: Doc[], opts: BuildLlmsTxtOptions = {}): string {
  const indexDir = dirname(llmsTxtPath(config))
  const linkFor = opts.linkFor ?? ((doc: Doc) => relative(indexDir, resolve(config.root, doc.key)).split(sep).join('/'))
  const lines: string[] = [`# ${llmsTxtTitle(config)}`, '', `> Index of every contrail-managed document.`, '']

  const grouped = new Map<string, Doc[]>()
  const uncategorized: Doc[] = []
  for (const doc of docs) {
    const kind = doc.frontmatter.kind
    if (!kind) {
      uncategorized.push(doc)
      continue
    }
    const list = grouped.get(kind) ?? []
    list.push(doc)
    grouped.set(kind, list)
  }

  const entry = (doc: Doc): string => {
    const stale = doc.frontmatter.status === 'stale' ? ' (stale)' : ''
    return `- [${doc.frontmatter.title}](${linkFor(doc)}): ${doc.frontmatter.summary}${stale}`
  }

  for (const { kind, label } of KIND_ORDER) {
    const list = grouped.get(kind)
    if (!list || list.length === 0) continue
    lines.push(`## ${label}`, '', ...list.map(entry), '')
  }
  if (uncategorized.length > 0) {
    lines.push('## Uncategorized', '', ...uncategorized.map(entry), '')
  }

  return lines.join('\n').replace(/\n+$/, '\n')
}

export function writeLlmsTxt(config: Config, docs: Doc[]): string {
  const path = llmsTxtPath(config)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buildLlmsTxt(config, docs))
  return path
}
