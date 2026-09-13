# contrail M2 — the project documentation substrate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** contrail becomes the standard way a project's documentation is generated and managed: a
scaffolded five-section structure, a document taxonomy, an audience boundary that cannot leak internal
figures to a client, live spreadsheet data inside money documents, and a published schema anything else
can target.

**Architecture:** contrail is a documentation tool with a published interface. It owns the folder
structure, the frontmatter schema, the audience boundary, the spreadsheet blocks, and the rendering to
a site and to `llms.txt`. Anything that produces documentation — a person, an agent, another plugin —
writes into that structure and validates against that schema. contrail neither knows nor cares what
produced a document, and it is fully useful with nothing else installed.

**Tech Stack:** TypeScript (strict, ESM), Node >= 22, `googleapis` for Sheets, vitest.

**Spec:** extends `docs/superpowers/specs/2026-09-12-contrail-design.md` and the M1.5 plan.

## Scope boundary — read this before adding anything

contrail generates and manages documentation. That is all it does.

It does not run the workflow, and it does not wire plugins to each other. It does not call an intake
agent, draft a PRD, deploy a prototype, push tasks to Plane, or know what step a project is on. Every
one of those is a sibling plugin with its own plan and its own quality bar, and the wiring between them
is done by the person using them — at the time they use them, in whatever order that project needs.

The practical test for any proposed feature: **does it require contrail to know something about another
system's state?** If yes, it does not belong here. A document may *link* to a Plane issue or a
spreadsheet, because a link is content. contrail reconciling against Plane's issue list is wiring, and
is out of scope.

contrail owns exactly five things:

1. **Structure** — the folder tree and what belongs where.
2. **Schema** — the frontmatter every document carries, and its validation.
3. **Safety** — the audience boundary between internal and client-visible material.
4. **Embedded data** — live spreadsheet ranges and links to artifacts that live outside the tree, as
   document *content*. Never reconciliation with another system's state.
5. **Rendering** — the site for people, `llms.txt` and Markdown for agents.

A feature that does not serve one of those five belongs somewhere else. That boundary is what keeps
contrail small enough to stay correct as the number of plugins around it grows.

## Verified constraint: the Google Drive MCP cannot write spreadsheet content

Checked directly against the attached server:

| Tool | Capability |
|---|---|
| `create_file` | creates a spreadsheet, optionally with initial content |
| `read_file_content` | returns a *natural-language representation*, not structured cells |
| `update_file` | **metadata only** — title and parent. Cannot write content. |
| `copy_file`, `search_files`, `share_file` | work as named |

No Sheets-specific MCP server is attached. Full read/write therefore cannot go through the MCP, and a design that assumed it would fail at the first write. contrail uses the **Google Sheets API directly** via `googleapis` with a service account — cell-level reads and writes, real ranges, no natural-language round trip.

## Global Constraints

- Node >= 22, ESM with explicit `.js` extensions, TS strict with `noUncheckedIndexedAccess`.
- Do not modify `src/plane/` or `src/emit/plane.ts` — dormant, not dead.
- Service-account credentials are read from the environment (`GOOGLE_APPLICATION_CREDENTIALS`) or an explicit config path. **Never** from a committed file, and never logged.
- Sheets writes follow M1's overwrite-guard pattern: read, hash, compare against the recorded hash, refuse to clobber an edit someone else made unless `--force`.
- Every new document kind ships with a template and a lint rule; a kind with neither is not done.

---

### Task 1: The document taxonomy and frontmatter schema

**Files:** `src/doc-kinds.ts`, `src/types.ts` (extend `Frontmatter`), `src/parse.ts` (validate), `tests/doc-kinds.test.ts`

Extend `Frontmatter` with the fields the substrate needs:

```ts
audience: 'internal' | 'client'      // defaults to 'internal' — opt IN to client visibility
section: '01-overview' | '02-planning' | '03-management' | '04-technical' | '05-delivery' | '00-meta'
docKind: DocKind                     // charter, business-case, stakeholders, domain-research,
                                     // glossary, scope, wbs, schedule, estimate, assumptions,
                                     // communication-plan, risk-log, budget, meeting, adr,
                                     // change-request, approval, open-questions, prd,
                                     // architecture, api-reference, prototype-registry,
                                     // test-plan, qa-report, deployment, release, acceptance, closure
owner?: string
reviewedOn?: string                  // ISO date; feeds a staleness rule later
sources?: string[]                   // provenance — which client artefact this came from
```

`audience` defaults to `'internal'` when absent. That default is the safety property: a document nobody classified is never published to a client.

`kind` (Diátaxis, from M1.5) stays separate from `docKind`. They answer different questions — `kind` is the shape of the writing, `docKind` is its role in the project. A PRD is `docKind: prd`, `kind: reference`.

Tests: an unknown `docKind` is rejected naming the valid set; `audience` defaults to internal; an invalid `audience` is rejected; a `docKind` whose conventional section disagrees with `section` produces a warning, not an error (projects reorganise, and the tool should not fight them).

---

### Task 2: Templates and `contrail init --template`

**Files:** `templates/project/**`, `src/scaffold.ts`, `src/cli.ts`, `tests/scaffold.test.ts`

`contrail init --template agency-project` scaffolds the full tree, every stub carrying correct frontmatter and a short prompt describing what belongs in it. A stub is not an empty file — an empty file teaches nothing and gets deleted; a stub with three guiding questions gets filled in.

```
docs/
  00-meta/project.yml
  01-overview/  charter.md  business-case.md  stakeholders.md
                domain-research.md  glossary.md  intake/README.md
  02-planning/  scope-statement.md  wbs.md  schedule.md
                estimate.md  assumptions.md
  03-management/ communication-plan.md  risk-log.md  budget.md
                 open-questions.md  approvals.md
                 meetings/README.md  decisions/README.md  change-requests/README.md
  04-technical/ prd.md  architecture.md  api-reference.md
                prototypes.md  diagrams/README.md
  05-delivery/  test-plan.md  deployment.md  acceptance.md  closure.md
                qa-reports/README.md  releases/README.md
```

`00-meta/project.yml` records client, project name and start date — the metadata the site header and
`llms.txt` need. It records no phase, no step, and no state belonging to another system.

**Customisation:** a project overrides any template file by having its own at the same path. `contrail init` never overwrites an existing file — it reports what it skipped. Run it again after adding a template and only the new files appear.

Also `contrail scaffold <docKind> <path>` — one document, correct frontmatter. It exists so that
nothing else has to hand-write frontmatter and drift from the schema.

Tests: init on an empty dir creates the tree; init twice is idempotent and overwrites nothing; every scaffolded stub passes `contrail check`; `scaffold` produces a document whose frontmatter validates.

---

### Task 3: The audience boundary

**Files:** `src/emit/site.ts`, `src/check.ts`, `src/cli.ts`, `tests/audience.test.ts`

`contrail site --audience client` emits only documents marked `audience: client`; the default emits everything. `llms.txt` is filtered the same way.

Lint rules, and these are **errors**, not warnings:

| Rule | Fires when |
|---|---|
| `internal-doc-exposed` | a document under `03-management/budget`, `estimate`, or with `docKind` in {budget, estimate} is marked `audience: client` |
| `unclassified-money-doc` | a money document has no explicit `audience` (the default protects it, but silence here should be loud) |

A client-facing build must also never emit a *link* to an internal document. A dangling link is a smaller failure than a leaked margin: rewrite it as plain text and report it.

Tests: a client build omits internal documents entirely — assert the file is absent, not merely unlinked; a link from a client document to an internal one is defanged; the two error rules fire; a client build of a tree with no client documents produces an empty site and says so rather than failing silently.

This task is the one with a real-world cost attached. Give it the most careful tests in the milestone.

---

### Task 4: Google Sheets — live read and write

**Files:** `src/sheets/client.ts`, `src/blocks/sheet.ts`, `src/emit/*` integration, `tests/sheets.test.ts`

A `sheet` block embeds live spreadsheet data:

````markdown
```sheet {id=<spreadsheet-id>, range="Estimate!A1:E40", summary="Effort estimate by workstream, totalling 214 days."}
```
````

- **site** — renders the range as an HTML table, plus a link to the Sheet and the timestamp of the read.
- **md (agents)** — renders the same range as a Markdown table. Agents get the numbers, not a link they cannot follow.
- Both carry the mandatory `summary`.

`src/sheets/client.ts` wraps `googleapis`:

```ts
interface SheetsApi {
  readRange(spreadsheetId: string, range: string): Promise<string[][]>
  writeRange(spreadsheetId: string, range: string, values: string[][], opts: { ifHash?: string, force?: boolean }): Promise<{ hash: string }>
  createFromTemplate(templateId: string, title: string, parentId?: string): Promise<{ spreadsheetId: string }>
}
```

**The write guard.** `writeRange` reads the target range first, hashes it, and compares against `ifHash` — the hash recorded when contrail last read it. A mismatch means a human edited the sheet, and the write is refused unless `force`. This is M1's overwrite guard applied to a second system, for the same reason: a spreadsheet is somebody's working document, and silently overwriting their edit is the worst thing this tool could do.

`contrail sheet pull <doc>` refreshes cached snapshots; `contrail sheet push <doc>` writes back, guarded.

Tests: the client is injected, never hitting the network; a stale `ifHash` refuses the write and names the range; `force` overrides; a read failure degrades to the cached snapshot with a visible staleness note rather than an empty table; credentials absent produces an actionable error naming the env var, not a stack trace.

**Credentials:** service-account JSON via `GOOGLE_APPLICATION_CREDENTIALS`, or `sheets.credentialsPath` in config. Document the sharing step — the Sheet must be shared with the service account's email, and nothing works until it is. Say so in the error message when a read 404s.

---

### Task 5: Structure and completeness lint

**Files:** `src/check.ts`, `tests/check-structure.test.ts`

New rules, all **warnings** — contrail reports what is missing and never blocks:

| Rule | Fires when |
|---|---|
| `missing-core-doc` | a section exists but a core document for it does not (e.g. `02-planning` with no `scope-statement.md`) |
| `empty-stub` | a scaffolded stub still has its placeholder text and no content |
| `orphan-doc` | a document sits outside the five sections |
| `no-owner` | a document has no `owner` |
| `unreviewed` | `reviewedOn` is more than 90 days old, or absent on a `current` document |

`contrail status` gains a documentation view: which core documents exist, which are still stubs, which
lack an owner, and which are overdue for review. It answers "what is the state of the documentation" —
not "what is the state of the project", which is a question about systems contrail does not read.

Warnings only, by deliberate choice. The earlier decision stands: a documentation tool that blocks work gets bypassed, and a bypassed tool enforces nothing.

---

### Task 6: The document schema and machine-readable interface

**Files:** `docs/document-schema.md`, `plugin/skills/writing-docs/SKILL.md` (extend), `src/cli.ts` (`--json` output)

contrail does not orchestrate sibling plugins, but it does have to be *writable by* them. This task
documents its own interface so any plugin — or a person — can produce documents contrail accepts,
without reading its source:

- the folder layout and which `docKind` belongs where;
- the complete frontmatter schema, with required and optional fields;
- `contrail scaffold <docKind> <path> --json` as the way to create a document, so no plugin hand-writes frontmatter;
- `contrail check --json` as the validator every plugin runs before declaring its step done;
- the rule that a producer writes documents and never reorganises the tree.

Nothing here calls a sibling plugin or knows one exists. It is a published schema plus a CLI other
tools can target, in the same way a file format is.

Give `scaffold`, `check` and `status` a `--json` mode. A sibling plugin parsing human-readable output is a plugin that breaks the first time a message is reworded.

The worked example should be the smallest real one: a producer creates `01-overview/intake/` and a
seeded `glossary.md` — scaffold, write, check, in that order. The example shows the interface, not a
workflow; whoever runs it decides when and why.

---

## Done when

- `contrail init --template agency-project` produces a tree that passes its own `check`.
- A client-audience build provably contains no internal document.
- A `sheet` block renders live data on the site and as a Markdown table for agents.
- A guarded write refuses to clobber a human's spreadsheet edit.
- `docs/document-schema.md` is complete enough that a producer can be written against it without reading contrail's source.

## Explicitly not in this milestone

Workflow automation, and wiring of any kind. Intake, research, PRD drafting, prototype deployment,
task breakdown, implementation and testing are sibling plugins. Connecting them is done by the person
using them. contrail contributes a place to put documents and a validator to check them — and stays
useful whether those plugins exist or not.
