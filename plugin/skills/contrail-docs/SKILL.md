---
name: contrail-docs
description: Use when creating, updating, reorganising, or removing a contrail-managed document under docs/ — a PRD, ADR, meeting note, scope statement, estimate, change request, QA report, release, or any other docKind — OR when answering a project-context question before writing anything from memory: "is X in scope?", "why did we decide X?", "how long will this take?", "what did we tell the client?", or any question about architecture, past decisions, estimates, risk, or open questions in a contrail project. Do not use for coding tasks unrelated to project scope, decisions, or documentation.
---

# contrail docs

**Before answering from memory, run `contrail context [--task <type>] [keywords...]`.**
Read only what it returns. An agent that read the right three documents beats one that read
none, or all forty-four. Task types: `feature`, `estimate`, `scope`, `decision`, `client-call`,
`onboard`, `test`, `deploy`, `risk` — the table each selects from is `src/context.ts`'s
`TASK_DOC_KINDS`, mirrored in `docs/using-contrail.md`. No matching task? Pass keywords instead;
`contrail context <keywords...>` searches title, summary and tags with no `--task` at all.

## Creating a document

`contrail scaffold <docKind> <path>`. Never hand-write frontmatter — it is the one way to get the
schema, section, and derived title right.

## Title convention for collection docKinds

| `docKind` | Discriminator | Pattern | Example |
|---|---|---|---|
| `meeting` | date | `<Purpose> — <D Month YYYY>` | Kickoff call — 11 August 2026 |
| `adr` | number | `ADR <NNNN> — <decision, present tense>` | ADR 0001 — The TMS stays the system of record |
| `change-request` | number + status | `CR <NNN> — <what> (<status>)` | CR 003 — Add mobile app (rejected) |
| `qa-report` | date | `<What was tested> — <D Month YYYY>` | UAT cycle 2 — 14 September 2026 |
| `release` | version + date | `<version> — <D Month YYYY>` | v1.2.0 — 20 September 2026 |

Every other `docKind` is a singleton — its kind name alone is title enough.

## Diagram type

| Text describes | Use | Answers |
|---|---|---|
| Components and how they connect | `architecture` | what talks to what |
| An ordered exchange between participants | `sequence` | what happens, in what order |
| A branching process with actors or handoffs | `workflow` | who does what, and where it can go wrong |
| Data crossing a system boundary | `dataflow` | where this came from, where it lands |
| An entity moving through states | `lifecycle` | what state is this in, what comes next |

Block syntax, the six diagramming rules, and the full frontmatter schema: `reference.md`.

## Before considering the work done

Run `contrail check`. **Added or removed a document — deletion included — run
`contrail check --index`**, or `llms.txt` keeps pointing at a file that no longer exists.

## The audience rule

`audience` defaults to `internal`. Marking a document `audience: client` is a deliberate act, not a
convenience default — get it wrong and a client build ships something they were never meant to see.
Full rule and the money-document guards: `reference.md`.
