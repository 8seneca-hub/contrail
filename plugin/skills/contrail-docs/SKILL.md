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

## Intake before interview

Ask what already exists before asking a person to recall anything: a brief or RFQ, a Drive folder,
spreadsheets, an OpenAPI spec, past proposals, meeting notes, a repo or wiki. Land each item
**verbatim** in `docs/01-overview/intake/` — that folder is for raw client material, it keeps its own
words, and the real documents cite the intake file they were synthesised from.

A spreadsheet is the exception to "copy it in": use a `sheet` block so the document carries live
values, a link back to the source and a cached snapshot, rather than numbers that quietly go stale.

## Starting a project: interview, do not guess

`contrail init` scaffolds documents that are nothing but guiding questions. Those questions are the
work, and the person in the conversation is the only source that can answer most of them.

1. `contrail questions` — the outstanding questions, grouped into rounds a person can answer in one
   sitting. Put each round to them in your own words. A whole round at a time, not one question at a
   time and not all sixty-six at once.
2. Write their answers into the documents that round named, then run `contrail questions` again.
   Answered documents drop out, so the interview resumes instead of repeating.
3. `unanswered: "<why not>"` is for what they told you they do not know — not for what you did not
   ask. A reason that only says the brief was thin means nobody was asked.

**Never invent a figure, a name or a date.** `contrail check` reports `unanswered-stub` on every
document still asking its questions and `contrail deploy` refuses while any remain, but the gate
cannot tell an answer from an invention. That part is on you.

## Two artefacts per document, two indexes

Every page ships twice: `.html` for people, `.md` for agents. The HTML index links only `.html`;
`llms.txt` links only `.md`. A person following the Plane Docs tab never reaches markdown.

There are likewise two `llms.txt`. `docs/llms.txt` lives in the repo with relative `.md` links, for
an agent reading the checkout — regenerate it with `contrail check --index` and commit it alongside
the documents. `site/llms.txt` is built with absolute `.html` URLs, for an agent fetching the
deployed site.

Before deploying, `contrail preview` builds the HTML and prints a `file://` link — give it to the
person and wait for them to confirm. A deploy refuses if a document changes after that preview, so
what was confirmed is what ships.

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

## Diagrams: Archify, never mermaid

A reader should see the shape of the system, not only read about it. Mermaid flattens to a PNG;
Archify renders explorable HTML with themes, views and export, and it is what `contrail check`
asks for.

Write the IR as JSON beside the document, then reference it:

````markdown
```archify {type=architecture, src=./diagrams/system.architecture.json, summary="How a render request reaches storage."}
```
````

- `summary` is mandatory — a missing one is a build error, not a warning.
- Set `meta.visual_preset` to `signal-flow` in the IR. Omit it and Archify falls back to `classic`,
  which is what "the diagram looks off" turns out to mean.
- The IR lives in the repo next to the document; `contrail site` and `contrail deploy` render it.
- **Every document needs one.** `undiagrammed-doc` is an error, not a warning, and a deploy refuses
  while any document has neither a diagram nor a reason.
- Where a document genuinely has no shape — a glossary is a list of terms, an approvals log a set of
  dates — set `nodiagram: "<why>"`. A filler diagram is worse than none: it teaches a reader that the
  diagrams here are decoration. Remove the marker when a diagram arrives, or `stale-nodiagram` fires.
- `0 diagram(s)` in the build output means no document referenced one — a silent miss, not a success.
- Not installed? Any render prints the install command and the `archify.bin` alternative. It ships as
  a skill, not an npm package, and installing the skill alone puts no `archify` on PATH.

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
