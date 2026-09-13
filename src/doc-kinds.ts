/**
 * The project-substrate taxonomy: what section a document lives in, and what
 * role it plays in the project (`docKind`). Kept separate from Diátaxis
 * `kind` in `types.ts` — that answers "how is this written", this answers
 * "what is this for".
 */

export type Section = '00-meta' | '01-overview' | '02-planning' | '03-management' | '04-technical' | '05-delivery'

export const SECTIONS: readonly Section[] = [
  '00-meta',
  '01-overview',
  '02-planning',
  '03-management',
  '04-technical',
  '05-delivery',
]

export type DocKind =
  | 'charter'
  | 'business-case'
  | 'stakeholders'
  | 'domain-research'
  | 'glossary'
  | 'scope'
  | 'wbs'
  | 'schedule'
  | 'estimate'
  | 'assumptions'
  | 'communication-plan'
  | 'risk-log'
  | 'budget'
  | 'meeting'
  | 'adr'
  | 'change-request'
  | 'approval'
  | 'open-questions'
  | 'prd'
  | 'architecture'
  | 'api-reference'
  | 'prototype-registry'
  | 'test-plan'
  | 'qa-report'
  | 'deployment'
  | 'release'
  | 'acceptance'
  | 'closure'

export const DOC_KINDS: readonly DocKind[] = [
  'charter',
  'business-case',
  'stakeholders',
  'domain-research',
  'glossary',
  'scope',
  'wbs',
  'schedule',
  'estimate',
  'assumptions',
  'communication-plan',
  'risk-log',
  'budget',
  'meeting',
  'adr',
  'change-request',
  'approval',
  'open-questions',
  'prd',
  'architecture',
  'api-reference',
  'prototype-registry',
  'test-plan',
  'qa-report',
  'deployment',
  'release',
  'acceptance',
  'closure',
]

export function isDocKind(value: string): value is DocKind {
  return (DOC_KINDS as readonly string[]).includes(value)
}

/**
 * Each `docKind`'s conventional home. A document's own `section` is allowed
 * to disagree — projects reorganise, and the tool should not fight them —
 * see `sectionMismatch` below, which reports that as a warning, never an
 * error.
 */
export const DOC_KIND_SECTION: Record<DocKind, Section> = {
  charter: '01-overview',
  'business-case': '01-overview',
  stakeholders: '01-overview',
  'domain-research': '01-overview',
  glossary: '01-overview',
  scope: '02-planning',
  wbs: '02-planning',
  schedule: '02-planning',
  estimate: '02-planning',
  assumptions: '02-planning',
  'communication-plan': '03-management',
  'risk-log': '03-management',
  budget: '03-management',
  meeting: '03-management',
  adr: '03-management',
  'change-request': '03-management',
  approval: '03-management',
  'open-questions': '03-management',
  prd: '04-technical',
  architecture: '04-technical',
  'api-reference': '04-technical',
  'prototype-registry': '04-technical',
  'test-plan': '05-delivery',
  'qa-report': '05-delivery',
  deployment: '05-delivery',
  release: '05-delivery',
  acceptance: '05-delivery',
  closure: '05-delivery',
}

export type Cardinality = 'singleton' | 'collection'
export type Discriminator = 'date' | 'number' | 'version'

export interface CollectionMeta {
  discriminator: Discriminator
  /** The expected title shape, shown in the `title-missing-discriminator` lint message
   * (check.ts) so the fix is obvious without looking anything up. */
  pattern: string
  /** One title matching `pattern`, shown alongside it in the same message. */
  example: string
}

/**
 * Most docKinds are singletons — one per project, for which the kind name alone is a sufficient
 * title (`Budget`, `Scope Statement`, `Project Charter`). A few are collections: many documents
 * share one docKind, so the title has to carry whatever tells them apart, because the same title
 * string is read out of context — in the site list, in `llms.txt`, in a browser tab, in an agent's
 * context window. Every docKind not listed here is a singleton; see `cardinalityOf`.
 */
export const COLLECTION_META: Partial<Record<DocKind, CollectionMeta>> = {
  meeting: {
    discriminator: 'date',
    pattern: '<Purpose> — <D Month YYYY>',
    example: 'Kickoff call — 11 August 2026',
  },
  adr: {
    discriminator: 'number',
    pattern: 'ADR <NNNN> — <decision, present tense>',
    example: 'ADR 0001 — The TMS stays the system of record',
  },
  'change-request': {
    discriminator: 'number',
    pattern: 'CR <NNN> — <what> (<status>)',
    example: 'CR 003 — Add mobile app (rejected)',
  },
  'qa-report': {
    discriminator: 'date',
    pattern: '<What was tested> — <D Month YYYY>',
    example: 'UAT cycle 2 — 14 September 2026',
  },
  release: {
    discriminator: 'version',
    pattern: '<version> — <D Month YYYY>',
    example: 'v1.2.0 — 20 September 2026',
  },
}

/** A docKind's cardinality: `'collection'` when it has an entry in `COLLECTION_META`, `'singleton'`
 * otherwise — derived rather than restated per-kind, since "not a collection" already means
 * singleton and every current and future singleton kind agreeing with that costs nothing to keep. */
export function cardinalityOf(docKind: DocKind): Cardinality {
  return docKind in COLLECTION_META ? 'collection' : 'singleton'
}

const SPELLED_DATE =
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/
const VERSION_TOKEN = /\bv?\d+\.\d+(?:\.\d+)?\b/i

/**
 * Whether `title` already carries the discriminator its collection docKind requires — the
 * `title-missing-discriminator` lint rule (check.ts) fires when it does not. Dates must be spelled
 * out (`11 August 2026`), matching the convention `deriveCollectionTitle` (scaffold.ts) generates,
 * not the ISO form that governs the filename. `number` is checked leniently (any digit at all) —
 * what matters is whether a reader can tell this document apart from its siblings, not that the
 * title spells out "ADR" or "CR" verbatim.
 */
export function discriminatorPresent(discriminator: Discriminator, title: string): boolean {
  switch (discriminator) {
    case 'date':
      return SPELLED_DATE.test(title)
    case 'number':
      return /\d/.test(title)
    case 'version':
      return VERSION_TOKEN.test(title)
  }
}

/**
 * A document's `section` disagreeing with its `docKind`'s conventional home
 * is never an error — projects reorganise their tree, and the tool should
 * not fight them — but it is worth a human noticing. Returns `undefined`
 * when they agree, or when `section` is not set at all.
 */
export function sectionMismatch(docKind: DocKind, section: Section | undefined): string | undefined {
  if (!section) return undefined
  const conventional = DOC_KIND_SECTION[docKind]
  if (section === conventional) return undefined
  return (
    `docKind '${docKind}' is conventionally filed under '${conventional}', but this document's ` +
    `section is '${section}'.`
  )
}
