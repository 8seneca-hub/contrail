import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DOC_KIND_SECTION, DOC_KINDS, isDocKind, type DocKind, type Section } from './doc-kinds.js'
import type { DiataxisKind } from './types.js'

export const CONFIG_TEMPLATE = `export default {
  plane: {
    baseUrl: 'https://plane.example.com',
    workspace: 'your-workspace-slug',
  },
  repos: {},
  docs: ['./docs/**/*.md', './*/docs/**/*.md'],
}
`

interface DocKindMeta {
  title: string
  kind: DiataxisKind
  summary: string
  questions: string[]
}

const DOC_KIND_META: Record<DocKind, DocKindMeta> = {
  charter: {
    title: 'Project Charter',
    kind: 'reference',
    summary: 'The mandate for this engagement: why it exists and what success means.',
    questions: [
      'Who sponsors this project, and what problem are they paying to solve?',
      'What is explicitly out of scope?',
      'What does success look like at handover?',
    ],
  },
  'business-case': {
    title: 'Business Case',
    kind: 'reference',
    summary: 'Why this project is worth doing, in business terms.',
    questions: [
      'What is the expected benefit, weighed against the cost?',
      'What alternatives were considered and rejected?',
      'Who approved the spend?',
    ],
  },
  stakeholders: {
    title: 'Stakeholders',
    kind: 'reference',
    summary: "Who has a stake in this project, and how each one is engaged.",
    questions: [
      'Who decides, and who is only informed?',
      "What is each stakeholder's preferred contact cadence?",
      'What is the escalation path when stakeholders disagree?',
    ],
  },
  'domain-research': {
    title: 'Domain Research',
    kind: 'explanation',
    summary: "What we learned about the client's domain before designing anything.",
    questions: [
      'What terminology did the client use that needed defining?',
      'What existing systems or processes does this project sit alongside?',
      'What assumptions is the project already building on top of?',
    ],
  },
  glossary: {
    title: 'Glossary',
    kind: 'reference',
    summary: 'Terms specific to this client or domain, defined once.',
    questions: [
      'Which words does the client use differently than the team expected?',
      'Which term did the team disagree about, and what was settled on?',
    ],
  },
  scope: {
    title: 'Project Scope',
    kind: 'reference',
    summary: 'What is being built, and what is explicitly not.',
    questions: [
      'What deliverables are in scope?',
      'What is explicitly excluded?',
      'How does a boundary dispute get resolved?',
    ],
  },
  wbs: {
    title: 'Work Breakdown Structure',
    kind: 'reference',
    summary: 'The work broken into pieces small enough to estimate and assign.',
    questions: [
      'What are the top-level deliverables?',
      'Who owns each work package?',
      'What dependencies exist between packages?',
    ],
  },
  schedule: {
    title: 'Schedule',
    kind: 'reference',
    summary: 'Milestones and target dates.',
    questions: [
      'Which deadlines are fixed by an external party?',
      'What are the internal milestones?',
      'What happens if a milestone slips?',
    ],
  },
  estimate: {
    title: 'Estimate',
    kind: 'reference',
    summary: 'Effort and cost estimate behind the schedule and budget.',
    questions: [
      'What estimation method was used?',
      'How confident is this estimate?',
      'What could make this estimate wrong?',
    ],
  },
  assumptions: {
    title: 'Assumptions',
    kind: 'reference',
    summary: 'Assumptions the plan depends on, so a broken one is caught early.',
    questions: [
      "What are we assuming about the client's systems, team, or timeline?",
      'Who owns checking each assumption still holds?',
    ],
  },
  'communication-plan': {
    title: 'Communication Plan',
    kind: 'reference',
    summary: 'Who needs to hear what, how often, and through which channel.',
    questions: [
      'What standing meetings exist, and who attends?',
      'Who is the escalation contact on each side?',
      'What is the reporting cadence?',
    ],
  },
  'risk-log': {
    title: 'Risk Log',
    kind: 'reference',
    summary: 'Known risks, their likelihood and impact, and how each is mitigated.',
    questions: [
      'What are the top risks today?',
      'Who owns each risk?',
      'What triggers an escalation?',
    ],
  },
  budget: {
    title: 'Budget',
    kind: 'reference',
    summary: 'Budget allocation across the project and how spend is tracked.',
    questions: [
      'How is the budget allocated across phases?',
      'What approval is required for an overage?',
      'Who tracks actuals against the plan?',
    ],
  },
  meeting: {
    title: 'Meeting Notes',
    kind: 'reference',
    summary: 'Notes from one meeting: decisions made and follow-ups owed.',
    questions: ['Who attended?', 'What was decided?', 'What action items are open, and who owns them?'],
  },
  adr: {
    title: 'Architecture Decision Record',
    kind: 'explanation',
    summary: 'One architecture decision: the choice made, the alternatives, and why.',
    questions: [
      'What forced this decision?',
      'What alternatives were considered?',
      'Who signed off, and what would change the decision later?',
    ],
  },
  'change-request': {
    title: 'Change Request',
    kind: 'reference',
    summary: 'A requested change to scope, schedule, or budget, and its disposition.',
    questions: [
      'What is changing, and why?',
      'What is the impact on schedule and budget?',
      'Who approved or rejected it?',
    ],
  },
  approval: {
    title: 'Approvals',
    kind: 'reference',
    summary: 'Sign-offs collected at each project gate.',
    questions: ['What is being approved?', 'Who has authority to approve it?', 'On what date was it approved?'],
  },
  'open-questions': {
    title: 'Open Questions',
    kind: 'reference',
    summary: 'Questions blocking progress until someone answers them.',
    questions: ['Who owns answering each question?', 'What is blocked until it is answered?'],
  },
  prd: {
    title: 'PRD',
    kind: 'reference',
    summary: "What we're building and why, for the team building it.",
    questions: [
      'What user problem does this solve?',
      'What is the success metric?',
      'What is explicitly a non-goal?',
    ],
  },
  architecture: {
    title: 'Architecture',
    kind: 'reference',
    summary: "The system's shape: its components, their boundaries, and how they connect.",
    questions: [
      'What are the major components, and what is each responsible for?',
      'What key trade-offs shaped this design?',
      'What was deliberately left out?',
    ],
  },
  'api-reference': {
    title: 'API Reference',
    kind: 'reference',
    summary: 'The contract other systems integrate against.',
    questions: [
      'What operations does this API expose?',
      'What is the auth model?',
      'What is the versioning policy?',
    ],
  },
  'prototype-registry': {
    title: 'Prototype Registry',
    kind: 'reference',
    summary: 'Prototypes built to de-risk a decision, and what each one proved.',
    questions: [
      'What question did this prototype answer?',
      'What was learned?',
      'Is it still live, or retired?',
    ],
  },
  'test-plan': {
    title: 'Test Plan',
    kind: 'reference',
    summary: "What gets tested, how, and what 'done' means for quality.",
    questions: [
      'What test types are covered — unit, integration, UAT?',
      'What is the acceptance threshold?',
      'Who signs off on results?',
    ],
  },
  'qa-report': {
    title: 'QA Report',
    kind: 'reference',
    summary: 'Results from one round of testing.',
    questions: ['What was tested?', 'What defects were found, and at what severity?', 'Is this ready to proceed?'],
  },
  deployment: {
    title: 'Deployment',
    kind: 'how-to',
    summary: 'How this project ships to its target environment.',
    questions: [
      'What are the deployment steps, in order?',
      'What is the rollback plan?',
      'Who has access to trigger a deploy?',
    ],
  },
  release: {
    title: 'Release',
    kind: 'reference',
    summary: 'What shipped in one release, and to whom.',
    questions: ['What changed in this release?', 'Who was notified?', 'Is any follow-up required?'],
  },
  acceptance: {
    title: 'Acceptance',
    kind: 'reference',
    summary: 'Criteria the client uses to accept the deliverable.',
    questions: [
      'What are the acceptance criteria?',
      'Who signs off?',
      "What happens if a criterion isn't met?",
    ],
  },
  closure: {
    title: 'Closure',
    kind: 'reference',
    summary: 'Formal wrap-up: what was delivered, what remains, and what was learned.',
    questions: [
      'What was handed over as the final deliverable?',
      'What remains outstanding, and who owns it?',
      'What would the team do differently next time?',
    ],
  },
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

/** Renders a scaffolded document: correct frontmatter plus a short prompt —
 * a few guiding questions, never a lecture — describing what belongs here. */
export function renderDocFile(docKind: DocKind): string {
  const meta = DOC_KIND_META[docKind]
  const lines = [
    '---',
    `title: ${yamlString(meta.title)}`,
    `summary: ${yamlString(meta.summary)}`,
    'status: draft',
    `kind: ${meta.kind}`,
    'audience: internal',
    `section: ${DOC_KIND_SECTION[docKind]}`,
    `docKind: ${docKind}`,
    '---',
    '',
    `# ${meta.title}`,
    '',
    '## Guiding questions',
    '',
    ...meta.questions.map((q) => `- ${q}`),
    '',
  ]
  return lines.join('\n')
}

interface IndexStub {
  path: string
  title: string
  section: Section
  summary: string
  notes: string[]
}

/** Folder-index stubs: these hold documents scaffolded on demand via
 * `contrail scaffold <docKind> <path>`, so they carry no `docKind` of their
 * own — just a pointer to the command that fills the folder. */
const INDEX_STUBS: IndexStub[] = [
  {
    path: '01-overview/intake/README.md',
    title: 'Intake',
    section: '01-overview',
    summary: "Raw material handed over by the client, before it's synthesized into an overview document.",
    notes: [
      'What did the client hand over, and when?',
      'Has it been synthesized into a proper document yet, or is it still raw?',
    ],
  },
  {
    path: '03-management/meetings/README.md',
    title: 'Meetings',
    section: '03-management',
    summary: 'One document per meeting — decisions and follow-ups, not a transcript.',
    notes: ["Add a new meeting note: `contrail scaffold meeting docs/03-management/meetings/<date>-<topic>.md`."],
  },
  {
    path: '03-management/decisions/README.md',
    title: 'Decisions',
    section: '03-management',
    summary: 'One ADR per architecture decision expensive enough to reverse that it needs a record.',
    notes: ['Add a new decision: `contrail scaffold adr docs/03-management/decisions/<NNN>-<slug>.md`.'],
  },
  {
    path: '03-management/change-requests/README.md',
    title: 'Change Requests',
    section: '03-management',
    summary: 'One document per requested change to scope, schedule, or budget.',
    notes: [
      'Add a new change request: `contrail scaffold change-request ' +
        'docs/03-management/change-requests/<NNN>-<slug>.md`.',
    ],
  },
  {
    path: '04-technical/diagrams/README.md',
    title: 'Diagrams',
    section: '04-technical',
    summary: 'Exported diagram assets referenced from documents elsewhere in this project.',
    notes: [
      "Prefer an `archify` block inside the relevant document over a screenshot dropped here.",
      'Keep an export here only when something outside this tree needs to link to it directly.',
    ],
  },
  {
    path: '05-delivery/qa-reports/README.md',
    title: 'QA Reports',
    section: '05-delivery',
    summary: 'One report per round of testing.',
    notes: ['Add a new report: `contrail scaffold qa-report docs/05-delivery/qa-reports/<date>.md`.'],
  },
  {
    path: '05-delivery/releases/README.md',
    title: 'Releases',
    section: '05-delivery',
    summary: 'One entry per release.',
    notes: ['Add a new entry: `contrail scaffold release docs/05-delivery/releases/<version>.md`.'],
  },
]

function renderIndexStub(stub: IndexStub): string {
  const lines = [
    '---',
    `title: ${yamlString(stub.title)}`,
    `summary: ${yamlString(stub.summary)}`,
    'status: draft',
    'kind: reference',
    'audience: internal',
    `section: ${stub.section}`,
    '---',
    '',
    `# ${stub.title}`,
    '',
    ...stub.notes.map((n) => `- ${n}`),
    '',
  ]
  return lines.join('\n')
}

export const DOC_FILES: ReadonlyArray<{ path: string; docKind: DocKind }> = [
  { path: '01-overview/charter.md', docKind: 'charter' },
  { path: '01-overview/business-case.md', docKind: 'business-case' },
  { path: '01-overview/stakeholders.md', docKind: 'stakeholders' },
  { path: '01-overview/domain-research.md', docKind: 'domain-research' },
  { path: '01-overview/glossary.md', docKind: 'glossary' },
  { path: '02-planning/scope-statement.md', docKind: 'scope' },
  { path: '02-planning/wbs.md', docKind: 'wbs' },
  { path: '02-planning/schedule.md', docKind: 'schedule' },
  { path: '02-planning/estimate.md', docKind: 'estimate' },
  { path: '02-planning/assumptions.md', docKind: 'assumptions' },
  { path: '03-management/communication-plan.md', docKind: 'communication-plan' },
  { path: '03-management/risk-log.md', docKind: 'risk-log' },
  { path: '03-management/budget.md', docKind: 'budget' },
  { path: '03-management/open-questions.md', docKind: 'open-questions' },
  { path: '03-management/approvals.md', docKind: 'approval' },
  { path: '04-technical/prd.md', docKind: 'prd' },
  { path: '04-technical/architecture.md', docKind: 'architecture' },
  { path: '04-technical/api-reference.md', docKind: 'api-reference' },
  { path: '04-technical/prototypes.md', docKind: 'prototype-registry' },
  { path: '05-delivery/test-plan.md', docKind: 'test-plan' },
  { path: '05-delivery/deployment.md', docKind: 'deployment' },
  { path: '05-delivery/acceptance.md', docKind: 'acceptance' },
  { path: '05-delivery/closure.md', docKind: 'closure' },
]

/**
 * The docKinds `init --template` scaffolds as a single file per project —
 * as opposed to `meeting`, `adr`, `change-request`, `qa-report` and `release`,
 * which live one-per-instance inside an `INDEX_STUBS` folder instead.
 * `missing-core-doc` (check.ts) uses this to know which docKind each section
 * is expected to have exactly one of.
 */
export const CORE_DOC_KINDS: readonly DocKind[] = DOC_FILES.map((f) => f.docKind)

function renderProjectYml(meta: { client: string; project: string; startDate: string }): string {
  // 00-meta/project.yml: client, project name, start date. Nothing else —
  // no phase, no current step, no id belonging to another system.
  return [
    `client: ${yamlString(meta.client)}`,
    `project: ${yamlString(meta.project)}`,
    `startDate: ${yamlString(meta.startDate)}`,
    '',
  ].join('\n')
}

export interface ScaffoldResult {
  created: string[]
  skipped: string[]
}

/** Writes `contents` to `absPath` unless it already exists. Never
 * overwrites — an `init` run against a live project must not lose work. */
function writeIfAbsent(absPath: string, contents: string, key: string, result: ScaffoldResult): void {
  if (existsSync(absPath)) {
    result.skipped.push(key)
    return
  }
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, contents)
  result.created.push(key)
}

export interface InitTemplateOptions {
  client?: string
  project?: string
  startDate?: string
}

/**
 * `contrail init --template agency-project`: scaffolds `contrail.config.ts`
 * plus the full `docs/` tree. Every existing file is left untouched and
 * reported as skipped — running this again after adding a template file
 * must only add what's new.
 */
export function runInitTemplate(cwd: string, opts: InitTemplateOptions = {}): ScaffoldResult {
  const result: ScaffoldResult = { created: [], skipped: [] }

  writeIfAbsent(join(cwd, 'contrail.config.ts'), CONFIG_TEMPLATE, 'contrail.config.ts', result)

  const docsRoot = join(cwd, 'docs')
  const meta = {
    client: opts.client ?? 'TODO: client name',
    project: opts.project ?? basename(resolve(cwd)),
    startDate: opts.startDate ?? new Date().toISOString().slice(0, 10),
  }
  writeIfAbsent(
    join(docsRoot, '00-meta', 'project.yml'),
    renderProjectYml(meta),
    'docs/00-meta/project.yml',
    result,
  )

  for (const file of DOC_FILES) {
    writeIfAbsent(join(docsRoot, file.path), renderDocFile(file.docKind), `docs/${file.path}`, result)
  }
  for (const stub of INDEX_STUBS) {
    writeIfAbsent(join(docsRoot, stub.path), renderIndexStub(stub), `docs/${stub.path}`, result)
  }

  return result
}

/**
 * `contrail scaffold <docKind> <path>`: one document, correct frontmatter,
 * so nothing else has to hand-write frontmatter and drift from the schema.
 * Unlike `init --template`, this targets one explicit path the caller named
 * — an existing file there refuses rather than silently skipping, the same
 * way plain `contrail init` refuses on an existing config.
 */
export function scaffoldDoc(docKind: string, targetPath: string): string {
  if (!isDocKind(docKind)) {
    throw new Error(`Unknown docKind '${docKind}'. Must be one of: ${DOC_KINDS.join(', ')}`)
  }
  if (existsSync(targetPath)) {
    throw new Error(`${targetPath} already exists.`)
  }
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, renderDocFile(docKind))
  return targetPath
}
