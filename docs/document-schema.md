# The contrail document schema

This is contrail's published interface: the folder layout, the frontmatter every document
carries, and the CLI surface a producer targets to create and validate documents — without
reading contrail's source. It is a file format plus a validator, the same way a JSON Schema
is. **Nothing here calls a sibling plugin or assumes one exists.** A producer writes
documents; it never reorganises the tree, and it never reads another system's state to decide
what to write.

## Folder layout

```
docs/
  00-meta/project.yml        # client, project, startDate — nothing else
  01-overview/    charter.md  business-case.md  stakeholders.md
                  domain-research.md  glossary.md  intake/
  02-planning/    scope-statement.md  wbs.md  schedule.md
                  estimate.md  assumptions.md
  03-management/  communication-plan.md  risk-log.md  budget.md
                  open-questions.md  approvals.md
                  meetings/  decisions/  change-requests/
  04-technical/   prd.md  architecture.md  api-reference.md
                  prototypes.md  diagrams/
  05-delivery/    test-plan.md  deployment.md  acceptance.md  closure.md
                  qa-reports/  releases/
```

`docs/**/*.md` is a document. `docs/00-meta/project.yml` is the one non-document file contrail
reads — it is metadata, not content: client, project name, start date. It records no phase, no
step, and no id belonging to another system.

### `docKind` → section (the conventional home)

Each `docKind` has exactly one section it is scaffolded into. A document's own `section`
field is allowed to disagree — projects reorganise, and contrail warns (`missing-core-doc` /
`orphan-doc` in `contrail check`), it never fights the tree.

| Section | `docKind`s (one file each, `contrail scaffold` names the conventional path) |
|---|---|
| `01-overview` | `charter`, `business-case`, `stakeholders`, `domain-research`, `glossary` |
| `02-planning` | `scope`, `wbs`, `schedule`, `estimate`, `assumptions` |
| `03-management` | `communication-plan`, `risk-log`, `budget`, `open-questions`, `approval` |
| `04-technical` | `prd`, `architecture`, `api-reference`, `prototype-registry` |
| `05-delivery` | `test-plan`, `deployment`, `acceptance`, `closure` |

Five `docKind`s are **per-instance**, not one-per-project — they live inside a folder instead
of at a single conventional path, one file per occurrence:

| `docKind` | Folder | Example instance path |
|---|---|---|
| `meeting` | `03-management/meetings/` | `03-management/meetings/2026-09-12-kickoff.md` |
| `adr` | `03-management/decisions/` | `03-management/decisions/001-use-postgres.md` |
| `change-request` | `03-management/change-requests/` | `03-management/change-requests/003-scope-add.md` |
| `qa-report` | `05-delivery/qa-reports/` | `05-delivery/qa-reports/2026-09-12.md` |
| `release` | `05-delivery/releases/` | `05-delivery/releases/v1.4.0.md` |

## Frontmatter schema

```yaml
---
title: string                          # required
summary: string                        # required — feeds the site, agent index, llms.txt
status: draft | review | current | stale   # required
audience: internal | client            # optional, defaults to 'internal'
kind: tutorial | how-to | reference | explanation   # optional, Diátaxis — how it's written
section: 00-meta | 01-overview | 02-planning | 03-management | 04-technical | 05-delivery
docKind: charter | business-case | stakeholders | domain-research | glossary |
         scope | wbs | schedule | estimate | assumptions |
         communication-plan | risk-log | budget | meeting | adr |
         change-request | approval | open-questions | prd |
         architecture | api-reference | prototype-registry |
         test-plan | qa-report | deployment | release | acceptance | closure
owner: string                          # optional — a name, not a system id
unanswered: string                     # optional — why the guiding questions have no answer yet
reviewedOn: string (ISO date)          # optional — quote it (see note below)
sources: string[]                      # optional — provenance: which client artefact this came from
repos: string[]                        # optional
tags: string[]                         # optional
decisions: number[]                    # optional
watch: string[]                        # optional
plane: { collection?: string, parent?: string }   # optional
---
```

**Required:** `title`, `summary`, `status`. Everything else is optional; `contrail check`
(`src/parse.ts`) rejects the document at parse time if a required field is missing or a typed
field holds a value outside its enum.

**`audience` is the safety property.** It defaults to `internal` when absent — a document
nobody has classified is never publishable to a client. Only an explicit `audience: client`
opts a document in. A money document (`docKind: budget`/`estimate`, or a path under
`03-management/budget` or `estimate`) marked `audience: client` is a build-breaking **error**
(`internal-doc-exposed`); one with no explicit `audience` at all is also an **error**
(`unclassified-money-doc`) — silence on a money document must be loud.

**Quote `reviewedOn`.** `reviewedOn: 2026-09-01` unquoted is valid YAML but parses as a Date
object, not a string, in most YAML parsers including contrail's. contrail normalizes it back
to `YYYY-MM-DD` at parse time either way, but writing `reviewedOn: "2026-09-01"` avoids
depending on that normalization.

## The lint (`contrail check`)

Every rule is a **warning** except two. contrail reports what is missing or wrong; it never
blocks a build over a warning. Warnings: `flow-without-diagram`, `steps-without-diagram`,
`undiagrammed-doc`, `mixed-mode`, `relative-time`, `dangling-reference`, `stale-doc`,
`missing-core-doc`, `empty-stub`, `orphan-doc`, `no-owner`, `unreviewed`. Errors (fail the
build even without `--strict`): `missing-summary`, `internal-doc-exposed`,
`unclassified-money-doc`.

A document still shaped like a freshly scaffolded stub (a bullet list of guiding
questions/notes, no prose yet) is exempt from every *content* rule above — a stub reads as
"empty" to those rules purely because of its heading text or short body, which is a lint flaw,
not a real finding. `empty-stub` is the one report a stub can earn, and only once it has been
promoted past `status: draft` with no content added — an untouched draft stub is expected,
not a problem. A freshly scaffolded tree (`contrail init --template agency-project`) passes
`contrail check` with **zero** findings.

## The CLI interface

Three commands accept `--json` for exact, stable, machine-parseable output. A sibling plugin
(or any producer) MUST use `--json`, never parse the human-readable text — a message gets
reworded; a JSON shape is the contract.

### `contrail scaffold <docKind> <path> --json`

The only supported way to create a document — nobody hand-writes frontmatter. Fails (and
never overwrites) if `<path>` already exists.

```json
// success (exit 0)
{"created": "/abs/path/to/docs/01-overview/intake/glossary.md"}
// failure (exit 1 or 2)
{"error": "Unknown docKind 'not-a-kind'. Must be one of: charter, business-case, ..."}
```

### `contrail check --json`

Run before declaring any writing step done.

```json
{
  "findings": [
    { "doc": "docs/03-management/budget.md", "line": 12, "rule": "no-owner",
      "message": "...", "severity": "warn" }
  ],
  "errors": 0,
  "warnings": 1,
  "indexPath": null,          // set when run with --index
  "exitCode": 0               // 1 if any error, or any warning under --strict
}
```

`line` is present only when the finding is attached to a specific position in the document;
`doc` is a section name (e.g. `"02-planning"`) rather than a file for `missing-core-doc`,
since that finding is about an absence, not one document.

### `contrail status --json`

The documentation view — what state the documentation is in. It never answers "what state is
the project in": that would require reading a system (Plane, a tracker) contrail does not
read.

```json
{
  "docs": [
    { "key": "docs/01-overview/charter.md", "status": "draft", "pageId": null,
      "stub": true, "noOwner": true, "overdue": false }
  ],
  "missingCoreDocs": [
    { "section": "02-planning", "message": "Section '02-planning' has documents but no 'wbs' — ..." }
  ],
  "summary": { "stubs": 1, "noOwner": 1, "overdue": 0 }
}
```

`stub` and `noOwner` here are raw facts about every document regardless of `status` — the
status view answers "which documents currently lack an owner", not the narrower lint question
of whether that is a problem yet.

## The one rule for any producer

**A producer writes documents. It never reorganises the tree.** It may `scaffold` a new
document at a path it chooses inside the standard layout above, and it may write content into
a document it owns. It never moves, renames, deletes, or restructures a document another
producer (or a person) created, and it never invents a new top-level section. Reorganising the
tree is a decision for the person running these tools, made deliberately, not a side effect of
a script doing its job.

## Worked example: the smallest real one

A producer wants to record project glossary terms it has just extracted from an intake
document. It creates the folder that holds intake material, then scaffolds and fills in a
glossary — nothing here calls another tool or knows one exists; whoever runs these three
commands decides when and why.

```console
$ mkdir -p docs/01-overview/intake

$ contrail scaffold glossary docs/01-overview/glossary.md --json
{"created":"/repo/docs/01-overview/glossary.md"}

$ cat >> docs/01-overview/glossary.md <<'EOF'

- **Settlement window** — the daily batch period during which pending transactions clear.
- **Clearing entity** — the counterparty a settlement is reconciled against.
EOF

$ contrail check --json
{"findings":[
  {"doc":"01-overview","rule":"missing-core-doc","severity":"warn",
   "message":"Section '01-overview' has documents but no 'charter' — scaffold one: `contrail scaffold charter docs/01-overview/<name>.md`."},
  {"doc":"01-overview","rule":"missing-core-doc","severity":"warn",
   "message":"Section '01-overview' has documents but no 'business-case' — scaffold one: ..."},
  {"doc":"01-overview","rule":"missing-core-doc","severity":"warn",
   "message":"Section '01-overview' has documents but no 'stakeholders' — scaffold one: ..."},
  {"doc":"01-overview","rule":"missing-core-doc","severity":"warn",
   "message":"Section '01-overview' has documents but no 'domain-research' — scaffold one: ..."}
],"errors":0,"warnings":4,"indexPath":null,"exitCode":0}
```

That is the whole interface: `scaffold` to create, a plain write to fill it in, `check` to
validate. `exitCode: 0` — these are honest warnings (this project has no charter yet, because
this producer's job is a glossary, not the whole overview section), never a block. What comes
before this (why this glossary, which intake document it came from) and after it (who reads it
next, whether someone scaffolds the rest of `01-overview`) is not contrail's concern.
