import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { COLLECTION_META, DOC_KIND_SECTION, DOC_KINDS, isDocKind, type DocKind, type Section } from './doc-kinds.js'
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

export interface PlaneTarget {
  baseUrl: string
  workspace: string
  projectId: string
}

/** The config file for a project already wired to a Plane project.
 *
 * No API key: it is read from `PLANE_API_KEY` and must never reach a file that
 * can be committed.
 */
export function renderConfig(plane?: PlaneTarget): string {
  if (!plane) return CONFIG_TEMPLATE
  return `export default {
  plane: {
    baseUrl: '${plane.baseUrl}',
    workspace: '${plane.workspace}',
  },
  repos: {},
  docs: ['./docs/**/*.md', './*/docs/**/*.md'],
  selfhost: {
    target: 'plane',
    projectId: '${plane.projectId}',
  },
}
`
}

/** A Plane project identifier derived from its name: uppercase alphanumerics,
 * capped at Plane's 12-character column. Returns undefined when the name holds
 * nothing usable, so the caller can ask for one rather than invent it. */
export function deriveIdentifier(name: string): string | undefined {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return letters.length > 0 ? letters.slice(0, 12) : undefined
}

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

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `2026-09-13` -> `13 September 2026` — spelled out, not ISO: the title is prose a person reads,
 * and the filename (not the title) is what needs to sort. */
function spelledDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  return `${day} ${MONTH_NAMES[month! - 1]} ${year}`
}

/** De-slugs a filename fragment into sentence case: `sprint-review` -> `Sprint review`. The result
 * will sometimes read awkwardly (`use-postgres` -> `Use postgres`, not `Use PostgreSQL`) — that is
 * fine and expected. It is a starting point the author edits, and still better than leaving the
 * bare docKind name (`Adr`) as the title. */
function deSlug(slug: string): string {
  const words = slug.split('-').filter(Boolean)
  if (words.length === 0) return ''
  const [first, ...rest] = words
  return [first!.charAt(0).toUpperCase() + first!.slice(1).toLowerCase(), ...rest.map((w) => w.toLowerCase())].join(
    ' ',
  )
}

const DATE_FILENAME = /^(\d{4}-\d{2}-\d{2})(?:-(.+))?$/
const NUMBER_FILENAME = /^(\d+)(?:-(.+))?$/
const VERSION_FILENAME = /^(v?\d+(?:\.\d+){1,2})(?:-(.+))?$/i

/**
 * Derives a starting title from the filename an author scaffolding a collection document (Task 7)
 * already chose — the discriminator is right there in the name they picked, so there is no reason
 * to make them type it twice. Returns `undefined` for a singleton docKind (there is nothing to
 * derive: `DOC_KIND_META`'s fixed title already is the title) or when the filename doesn't actually
 * carry its docKind's discriminator (an unusual name `contrail scaffold` didn't suggest) — the
 * fixed title is still a safe fallback either way.
 */
function deriveCollectionTitle(docKind: DocKind, filenameStem: string): string | undefined {
  const meta = COLLECTION_META[docKind]
  if (!meta) return undefined

  if (meta.discriminator === 'date') {
    const match = DATE_FILENAME.exec(filenameStem)
    if (!match) return undefined
    const purpose = match[2] ? deSlug(match[2]) : 'Untitled'
    return `${purpose} — ${spelledDate(match[1]!)}`
  }

  if (meta.discriminator === 'number') {
    const match = NUMBER_FILENAME.exec(filenameStem)
    if (!match) return undefined
    const prefix = docKind === 'adr' ? 'ADR' : 'CR'
    const what = match[2] ? deSlug(match[2]) : 'Untitled'
    return `${prefix} ${match[1]} — ${what}`
  }

  // version
  const match = VERSION_FILENAME.exec(filenameStem)
  if (!match) return undefined
  return `${match[1]} — ${spelledDate(new Date().toISOString().slice(0, 10))}`
}

/** One round of the intake interview: the questions a person can answer in a
 * single sitting, and the documents those answers fill.
 *
 * Grouped by conversation, NOT by section — sections split the money questions
 * across three folders, so asking section by section makes a person answer
 * "who approves spend" in round one and "what approval does an overage need"
 * in round three. Grouping by theme also collapses the near-duplicates: four
 * documents ask some form of "who decides", and they belong in one question. */
export interface InterviewRound {
  theme: string
  docKinds: DocKind[]
}

/** The rounds themselves. Lives beside `DOC_KIND_META` on purpose: adding a
 * docKind means deciding its questions and the conversation they belong to in
 * the same edit. `tests/interview.test.ts` fails if a scaffolded docKind ends
 * up in no round, so a new one cannot quietly vanish from the interview. */
export const INTERVIEW_ROUNDS: readonly InterviewRound[] = [
  {
    theme: 'Mandate and money — who wants this, who pays, and what it is worth',
    docKinds: ['charter', 'business-case', 'budget', 'approval', 'estimate'],
  },
  {
    theme: 'People and cadence — who decides, who is told, and how often',
    docKinds: ['stakeholders', 'communication-plan'],
  },
  {
    theme: 'Scope and assumptions — what is in, what is out, what we are taking on faith',
    docKinds: ['scope', 'wbs', 'assumptions'],
  },
  {
    theme: 'Product and domain — the user problem, the success metric, the vocabulary',
    docKinds: ['prd', 'domain-research', 'glossary'],
  },
  {
    theme: 'Technical shape — components, interfaces, and what has already been tried',
    docKinds: ['architecture', 'api-reference', 'prototype-registry'],
  },
  {
    theme: 'Delivery and risk — dates, what could go wrong, and what "done" means',
    docKinds: ['schedule', 'risk-log', 'test-plan', 'acceptance', 'deployment', 'closure'],
  },
]

/** A document still waiting on answers, with the questions to put to a person. */
export interface InterviewDocument {
  key: string
  docKind: DocKind
  questions: readonly string[]
}

/** A round as asked: renumbered against the rounds that still have work. */
export interface PendingRound {
  number: number
  of: number
  theme: string
  documents: InterviewDocument[]
}

/**
 * The interview still outstanding in `root`, round by round.
 *
 * A document drops out as soon as it is settled — either it grew real content
 * or it recorded an `unanswered` reason — so this is safe to call between
 * rounds and drives a resumable loop rather than one long dump. Rounds are
 * renumbered over what is left, because "round 1 of 2" is the truth a person
 * needs and "round 4 of 6" is bookkeeping from an interview they already
 * half-finished.
 */
export function interviewRounds(root: string): PendingRound[] {
  const pendingByKind = new Map<DocKind, InterviewDocument[]>()
  for (const file of DOC_FILES) {
    const key = `docs/${file.path}`
    const abs = join(root, key)
    if (!existsSync(abs)) continue
    if (isSettled(readFileSync(abs, 'utf8'))) continue
    const list = pendingByKind.get(file.docKind) ?? []
    list.push({ key, docKind: file.docKind, questions: guidingQuestions(file.docKind) })
    pendingByKind.set(file.docKind, list)
  }

  const withWork = INTERVIEW_ROUNDS.map((round) => ({
    theme: round.theme,
    documents: round.docKinds.flatMap((kind) => pendingByKind.get(kind) ?? []),
  })).filter((round) => round.documents.length > 0)

  return withWork.map((round, index) => ({
    number: index + 1,
    of: withWork.length,
    theme: round.theme,
    documents: round.documents,
  }))
}

/**
 * Whether a scaffolded document needs nothing more from a person: it recorded
 * an `unanswered` reason, or it has a paragraph of real prose.
 *
 * Read off the raw file rather than through `parseDoc` so that `scaffold.ts`
 * does not depend on the parser (and, through it, on `check.ts`, which already
 * imports from here). The shape is the one `renderDocFile` writes a few lines
 * up, so the two stay honest together: frontmatter, a heading, and bullets.
 */
function isSettled(contents: string): boolean {
  const end = contents.indexOf('\n---', 4)
  const frontmatter = end === -1 ? '' : contents.slice(0, end)
  if (/^unanswered:/m.test(frontmatter)) return true

  const body = end === -1 ? contents : contents.slice(end + 4)
  return body
    .split('\n')
    .some((line) => line.trim() !== '' && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('*'))
}

/** The guiding questions a scaffolded document of this kind asks. Exported so
 * that `unanswered-stub` can quote the questions a document is still ducking,
 * and `init` can hand them over as work, from this one definition — a second
 * copy of the questions would drift from the scaffold within a release. */
export function guidingQuestions(docKind: DocKind): readonly string[] {
  return DOC_KIND_META[docKind].questions
}

/** Renders a scaffolded document: correct frontmatter plus a short prompt —
 * a few guiding questions, never a lecture — describing what belongs here.
 * `targetPath`, when given, lets a collection docKind (Task 7) derive its
 * title from the filename the author chose rather than falling back to the
 * generic `DOC_KIND_META` title (`Meeting Notes`, `ADR`, ...). */
export function renderDocFile(docKind: DocKind, targetPath?: string): string {
  const meta = DOC_KIND_META[docKind]
  const derivedTitle = targetPath ? deriveCollectionTitle(docKind, basename(targetPath, '.md')) : undefined
  const title = derivedTitle ?? meta.title
  const lines = [
    '---',
    `title: ${yamlString(title)}`,
    `summary: ${yamlString(meta.summary)}`,
    'status: draft',
    `kind: ${meta.kind}`,
    'audience: internal',
    `section: ${DOC_KIND_SECTION[docKind]}`,
    `docKind: ${docKind}`,
    '---',
    '',
    `# ${title}`,
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
    notes: [
      'Add a new meeting note: `contrail scaffold meeting docs/03-management/meetings/<date>-<topic>.md` ' +
        '— the title convention is "<Purpose> — <D Month YYYY>", e.g. "Kickoff call — 11 August 2026".',
    ],
  },
  {
    path: '03-management/decisions/README.md',
    title: 'Decisions',
    section: '03-management',
    summary: 'One ADR per architecture decision expensive enough to reverse that it needs a record.',
    notes: [
      'Add a new decision: `contrail scaffold adr docs/03-management/decisions/<NNN>-<slug>.md` ' +
        '— the title convention is "ADR <NNNN> — <decision, present tense>", e.g. ' +
        '"ADR 0001 — The TMS stays the system of record".',
    ],
  },
  {
    path: '03-management/change-requests/README.md',
    title: 'Change Requests',
    section: '03-management',
    summary: 'One document per requested change to scope, schedule, or budget.',
    notes: [
      'Add a new change request: `contrail scaffold change-request ' +
        'docs/03-management/change-requests/<NNN>-<slug>.md` — the title convention is ' +
        '"CR <NNN> — <what> (<status>)", e.g. "CR 003 — Add mobile app (rejected)".',
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
    notes: [
      'Add a new report: `contrail scaffold qa-report docs/05-delivery/qa-reports/<date>-<what-was-tested>.md` ' +
        '— the title convention is "<What was tested> — <D Month YYYY>".',
    ],
  },
  {
    path: '05-delivery/releases/README.md',
    title: 'Releases',
    section: '05-delivery',
    summary: 'One entry per release.',
    notes: [
      'Add a new entry: `contrail scaffold release docs/05-delivery/releases/<version>.md` — the ' +
        'title convention is "<version> — <D Month YYYY>", e.g. "v1.2.0 — 20 September 2026".',
    ],
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

/** The work a fresh scaffold just created, stated as the questions each new
 * document has to answer.
 *
 * `init` reports this because the alternative is what actually happens
 * otherwise: the tree gets published with its placeholder pages intact,
 * because nobody reading a list of `CREATED` paths can see which of them are
 * questions waiting for answers. Only the template's docKind-bearing files
 * appear — the config, the metadata file and the folder READMEs have no
 * questions to answer. */
export function guidingQuestionReportLines(result: ScaffoldResult): string[] {
  const created = new Set(result.created)
  const pending = DOC_FILES.filter((file) => created.has(`docs/${file.path}`))
  if (pending.length === 0) return []

  const lines = [
    '',
    `${pending.length} document(s) ask guiding questions that are not answered yet. In order:`,
    '',
    '  1. Answer what the material you were given actually answers.',
    '  2. ASK A PERSON the rest. Run `contrail questions` for them grouped into rounds, and put each',
    '     round to whoever is in the conversation with you. They are the only source that can answer',
    '     most of these.',
    '  3. Only what they say they do not know earns `unanswered: "<what is missing, and that they',
    '     were asked>"`, plus a row in 03-management/open-questions.md.',
    '',
    'Never invent a figure, a name or a date to fill a gap. `contrail deploy` refuses until every',
    'document is answered or marked, and marking them all is how a docs tree becomes placeholder.',
    '',
  ]
  for (const file of pending) {
    lines.push(`docs/${file.path}`)
    lines.push(...guidingQuestions(file.docKind).map((question) => `  - ${question}`))
    lines.push('')
  }
  return lines
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
  /** Present when `init` created or was pointed at a Plane project, so the
   * config it writes is already wired to deploy. */
  plane?: PlaneTarget
}

/**
 * `contrail init --template agency-project`: scaffolds `contrail.config.ts`
 * plus the full `docs/` tree. Every existing file is left untouched and
 * reported as skipped — running this again after adding a template file
 * must only add what's new.
 */
export function runInitTemplate(cwd: string, opts: InitTemplateOptions = {}): ScaffoldResult {
  const result: ScaffoldResult = { created: [], skipped: [] }

  writeIfAbsent(join(cwd, 'contrail.config.ts'), renderConfig(opts.plane), 'contrail.config.ts', result)

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
  writeFileSync(targetPath, renderDocFile(docKind, targetPath))
  return targetPath
}
