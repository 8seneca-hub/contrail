import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { visit } from 'unist-util-visit'
import type { Heading, List, Root, RootContent, Text } from 'mdast'
import { parseAttrs } from './blocks/attrs.js'
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

export function checkDocs(docs: Doc[], _opts: { strict?: boolean } = {}): Finding[] {
  const findings: Finding[] = []

  for (const doc of docs) {
    const children = doc.tree.children
    checkFlowWithoutDiagram(doc, children, findings)
    checkStepsWithoutDiagram(doc, children, findings)
    checkUndiagrammedDoc(doc, findings)
    checkMissingSummary(doc, findings)
    checkStaleDoc(doc, findings)
    checkMixedMode(doc, findings)
    checkProseHygiene(doc, findings)
    checkInternalDocExposed(doc, findings)
    checkUnclassifiedMoneyDoc(doc, findings)
  }

  return findings
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
export function buildLlmsTxt(config: Config, docs: Doc[]): string {
  const indexDir = dirname(llmsTxtPath(config))
  const lines: string[] = [`# ${config.plane.workspace}`, '', `> Index of every contrail-managed document.`, '']

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
    const linkPath = relative(indexDir, resolve(config.root, doc.key)).split(sep).join('/')
    const stale = doc.frontmatter.status === 'stale' ? ' (stale)' : ''
    return `- [${doc.frontmatter.title}](${linkPath}): ${doc.frontmatter.summary}${stale}`
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
