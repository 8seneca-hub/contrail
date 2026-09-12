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
