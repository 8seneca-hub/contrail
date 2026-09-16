import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { visit } from 'unist-util-visit'
import type { Heading, Link, List, ListItem, Root, RootContent, Text } from 'mdast'
import { parseAttrs } from './blocks/attrs.js'
import { readProjectMeta } from './config.js'
import {
  COLLECTION_META,
  discriminatorPresent,
  DOC_KIND_SECTION,
  SECTIONS,
  type DocKind,
  type Section,
} from './doc-kinds.js'
import { docsForAudience, pageFileFor } from './emit/site.js'
import { CORE_DOC_KINDS, guidingQuestions } from './scaffold.js'
import type { Audience, Config, Doc } from './types.js'

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
 * Common imperative-verb openers for a procedural step — not exhaustive (this is a heuristic, not a
 * grammar parser), but it covers the verbs that dominate real how-to prose: open a tool, run a
 * command, click a button, merge a branch. A leading connector ("Then", "Next", "First", ...) is
 * stripped before the check, since "Then restart the service" is still an imperative step even
 * though its first word is a connector rather than the verb itself.
 */
const IMPERATIVE_VERBS = new Set([
  'run', 'open', 'click', 'merge', 'deploy', 'install', 'configure', 'add', 'remove', 'delete',
  'update', 'set', 'enable', 'disable', 'navigate', 'select', 'choose', 'verify', 'check',
  'confirm', 'restart', 'start', 'stop', 'build', 'push', 'pull', 'commit', 'sign', 'go', 'type',
  'enter', 'copy', 'paste', 'save', 'export', 'import', 'review', 'submit', 'wait', 'ensure',
  'use', 'download', 'upload', 'edit', 'write', 'read', 'execute', 'launch', 'create', 'send',
  'fill', 'log', 'turn', 'attach', 'assign', 'schedule', 'approve', 'request', 'grant', 'revoke',
  'reset', 'clone', 'checkout', 'fetch', 'rebase', 'tag', 'release', 'publish', 'generate',
  'apply', 'test', 'validate', 'close', 'connect', 'disconnect', 'restore', 'backup', 'do', 'make',
  'call', 'ask', 'notify', 'switch', 'toggle', 'move', 'rename', 'find', 'search', 'wait',
])
const LEADING_CONNECTOR = /^(?:then|next|first|second|third|finally|afterward|afterwards|now|once done|after that|also)\b[,:]?\s*/i

/** A list item's flattened text, the same way `headingText` reads a heading. */
function listItemText(item: ListItem): string {
  let text = ''
  visit(item, 'text', (t: Text) => {
    text += t.value
  })
  return text.trim()
}

/**
 * Whether a list item reads like a procedural step rather than a question, a finding, or an
 * option: a question ends in "?" and is never a step regardless of its first word; anything else
 * counts as imperative only when its first real word (after stripping a leading connector) is a
 * verb this project's docs actually use to give instructions.
 */
function looksImperative(text: string): boolean {
  if (text.endsWith('?')) return false
  const stripped = text.replace(LEADING_CONNECTOR, '')
  const firstWord = stripped.match(/^[A-Za-z]+/)?.[0]?.toLowerCase()
  return firstWord !== undefined && IMPERATIVE_VERBS.has(firstWord)
}

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
      const items = node.children as ListItem[]
      if (items.length === 0) return

      // A numbered list is a procedure only when most of its items read as instructions — a list of
      // open questions, findings, or options is a normal shape for an explanation document and must
      // never be mistaken for one. Reporting on a shape that isn't actually a procedure is worse than
      // reporting nothing: it teaches people to skim past every warning, including the real ones.
      const imperativeCount = items.filter((item) => looksImperative(listItemText(item))).length
      if (imperativeCount * 2 <= items.length) return

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
 * The audience boundary, part three: a client-visible document must never
 * link to the internal site's own address. Vercel Authentication keeps the
 * internal deployment itself out of reach, but the URL alone already tells
 * the client "a document about you exists here" — that is a leak in its
 * own right, independent of whether they can log in. Only fires when
 * `site.internalUrl` is configured; a tree with no deployed internal site
 * yet has nothing to compare against.
 */
function checkClientDocLinksInternal(doc: Doc, internalUrl: string | undefined, findings: Finding[]): void {
  if (!internalUrl || doc.frontmatter.audience !== 'client') return

  visit(doc.tree, 'link', (node: Link) => {
    if (node.url !== internalUrl && !node.url.startsWith(`${internalUrl}/`)) return
    findings.push({
      doc: doc.key,
      line: node.position?.start.line,
      rule: 'client-doc-links-internal',
      severity: 'error',
      message:
        `This client-visible document links to the internal site (${node.url}). A client can never reach ` +
        'that page, but the URL alone tells them a document about them exists there — remove the link, ' +
        'or point it at `site.clientUrl` instead.',
    })
  })
}

const DISCRIMINATOR_NOUN: Record<'date' | 'number' | 'version', string> = {
  date: 'date',
  number: 'number',
  version: 'version',
}

/**
 * Task 7: a document title is read out of context — in the site list, in `llms.txt`, in a browser
 * tab, in an agent's context window — so a collection docKind's title has to carry whatever
 * distinguishes it from its siblings. `COLLECTION_META` (doc-kinds.ts) says which docKinds are
 * collections and what discriminator each one requires; a singleton docKind (`meta` undefined)
 * never fires. Warning, not error: an existing tree should not fail its first `check` over titles,
 * and this is a readability convention, not a safety property the way `internal-doc-exposed` is.
 */
function checkTitleMissingDiscriminator(doc: Doc, findings: Finding[]): void {
  const docKind = doc.frontmatter.docKind
  if (!docKind) return
  const meta = COLLECTION_META[docKind]
  if (!meta) return
  if (discriminatorPresent(meta.discriminator, doc.frontmatter.title)) return

  findings.push({
    doc: doc.key,
    rule: 'title-missing-discriminator',
    severity: 'warn',
    message:
      `Title "${doc.frontmatter.title}" has no ${DISCRIMINATOR_NOUN[meta.discriminator]} — a ${docKind} title ` +
      'is read in a list of many. ' +
      `Expected: "${meta.pattern}", e.g. "${meta.example}".`,
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
 * A stub whose `status` has been promoted past `draft` (review/current/stale)
 * while the body is still the placeholder — a claim of progress the content
 * doesn't back up. The six content rules skip a stub outright (see
 * `checkDocs`), so the only reports a stub can earn are this one and
 * `unanswered-stub` below, which answer different questions: this one is
 * about a false status, that one about unanswered questions.
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

/**
 * A scaffolded document still asking its guiding questions, with no record of
 * why. This is the rule a fresh `init` is SUPPOSED to light up: the questions
 * are the work, and an unfilled document that publishes anyway is how a docs
 * tree fills with placeholder pages nobody reads.
 *
 * Two deliberate exemptions:
 *
 * - No `docKind` means a folder README (`INDEX_STUBS` in scaffold.ts) — a
 *   pointer to a folder that fills on demand, so it is meant to stay a stub.
 * - An `unanswered` reason clears it. "The client never told us the budget"
 *   is a real answer to a guiding question, and recording it beats the
 *   alternative this rule exists to prevent: inventing a number that reads
 *   like fact.
 */
function checkUnansweredStub(doc: Doc, findings: Finding[]): void {
  if (!isStub(doc)) return
  const docKind = doc.frontmatter.docKind
  if (docKind === undefined) return
  if (doc.frontmatter.unanswered !== undefined) return
  const questions = guidingQuestions(docKind)
  findings.push({
    doc: doc.key,
    rule: 'unanswered-stub',
    severity: 'warn',
    message:
      'This document still asks its guiding questions and answers none of them: ' +
      `${questions.join(' ')} ` +
      'Answer them, or set `unanswered: "<why not>"` in the frontmatter to record what is missing. ' +
      'A deploy is blocked until one of the two is true.',
  })
}

/**
 * The mirror of `unanswered-stub`: a document that grew real content but kept
 * the excuse in its frontmatter. Left alone, the `unanswered` roster reports
 * work as blocked long after it landed, which is worse than no roster.
 */
function checkStaleUnanswered(doc: Doc, findings: Finding[]): void {
  if (doc.frontmatter.unanswered === undefined) return
  if (isStub(doc)) return
  findings.push({
    doc: doc.key,
    rule: 'stale-unanswered',
    severity: 'warn',
    message:
      'This document has real content but still carries `unanswered` in its frontmatter — remove it, ' +
      'or the unanswered roster keeps reporting finished work as blocked.',
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

export function checkDocs(docs: Doc[], opts: { strict?: boolean; internalUrl?: string } = {}): Finding[] {
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
    checkClientDocLinksInternal(doc, opts.internalUrl, findings)
    checkTitleMissingDiscriminator(doc, findings)
    checkEmptyStub(doc, findings)
    checkUnansweredStub(doc, findings)
    checkStaleUnanswered(doc, findings)
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
  /** Document keys `unanswered-stub` fired on: still asking their guiding
   * questions, with no reason recorded. These are the ones a deploy refuses. */
  unanswered: string[]
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
    unanswered: findings.filter((f) => f.rule === 'unanswered-stub').map((f) => f.doc),
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
  /**
   * When set, every entry links with an absolute URL against this site
   * address instead of the bare path `linkFor` returns — so an agent can
   * fetch the document directly rather than guess at its path. `contrail
   * site` passes `site.internalUrl`/`site.clientUrl` depending on which
   * audience is building; a tree with neither configured keeps the
   * relative link, which is the default and remains fully supported.
   */
  baseUrl?: string
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
    const path = linkFor(doc)
    const href = opts.baseUrl ? `${opts.baseUrl}/${path}` : path
    return `- [${doc.frontmatter.title}](${href}): ${doc.frontmatter.summary}${stale}`
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

/**
 * Writes this build's own `llms.txt` INTO a site output directory, next to the pages it describes
 * — Ruling 2: the same `audience` that governed which pages a build wrote governs this index too,
 * one write producing both halves of the artifact so they can never disagree the way a build and a
 * separately-run `check --index` could. Links point at the emitted page files (`pageFileFor`), not
 * the source `.md` paths, since only the pages exist at this location.
 *
 * Every builder of a site output directory calls this explicitly — `contrail site` and both
 * `contrail deploy` build paths (vercel and self-hosted) — rather than `buildSite` writing it
 * internally: `buildSite` has no dependency on `Config` today (it takes the individual fields it
 * needs, like `projectName`), and pulling in `Config` just for this build's title fallback
 * (`llmsTxtTitle`'s `basename(config.root)` case) would be a new coupling for one caller's benefit.
 * Three call sites sharing one implementation gets the "no future caller can forget" property this
 * is really after, without that coupling. `llms.txt` is "the only thing an agent has to discover
 * what documents exist" (`docs/plane-docs-api-spec.md`) — a build that skips this is not usable by
 * the agent-facing half of this feature at all.
 *
 * `baseUrl` is optional and, unlike `contrail site`, every `contrail deploy` call site omits it:
 * `deploy` never bakes `site.internalUrl`/`clientUrl` into the pages it builds either (no target's
 * final address is knowable at build time the way it is for the standalone `site` command), so its
 * copy of `llms.txt` stays relative too, matching the pages it sits beside.
 */
export function writeSiteLlmsTxt(
  config: Config,
  docs: Doc[],
  audience: Audience | undefined,
  outDir: string,
  baseUrl?: string,
): string {
  const path = join(outDir, 'llms.txt')
  writeFileSync(
    path,
    buildLlmsTxt(config, docsForAudience(docs, audience), { linkFor: (doc) => pageFileFor(doc.key), baseUrl }),
  )
  return path
}
