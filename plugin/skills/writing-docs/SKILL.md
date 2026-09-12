---
name: writing-docs
description: Author or edit a contrail-managed Markdown document — picking the right Archify diagram type, the block syntax, and the frontmatter contrail needs, then validating with `contrail check`.
---

# Writing contrail docs

## Frontmatter

```yaml
---
title: string, required
summary: string, required — feeds the site, the agent index, and llms.txt
status: draft | review | current | stale
audience: internal | client   # optional, defaults to 'internal'
kind: tutorial | how-to | reference | explanation   # optional, Diátaxis
section: 00-meta | 01-overview | 02-planning | 03-management | 04-technical | 05-delivery
docKind: see taxonomy below
owner: string           # optional; expected once status leaves 'draft'
reviewedOn: "YYYY-MM-DD"  # optional; quote it — unquoted YAML parses as a Date, not a string
---
```

Pick one `kind`. Mixing forms in one document — a how-to that stops to explain
theory, an explanation that lists numbered steps — is the most common
documentation failure. `contrail check` flags it when `kind` is set.

## The audience rule

`audience` is the client-visibility gate, not a convenience field. It defaults to
`internal` — a document nobody has classified is never publishable to a client.
Only an explicit `audience: client` opts a document in; never guess it. A money
document (`docKind: budget`/`estimate`, or a path under `03-management/budget` or
`estimate`) marked `audience: client` is a build error, and one with `audience`
left unset at all is *also* an error — silence on a money document must be loud.
`contrail site --audience client` and its own `llms.txt` emit only what is
explicitly opted in; everything else is simply absent from that build, not
merely unlinked.

## Document taxonomy: `docKind` → `section`

Full schema, including the machine-readable `--json` interface for `scaffold`,
`check` and `status`: `docs/document-schema.md`. Summary — one core file per
`docKind` per section:

| Section | `docKind`s |
|---|---|
| `01-overview` | `charter`, `business-case`, `stakeholders`, `domain-research`, `glossary` |
| `02-planning` | `scope`, `wbs`, `schedule`, `estimate`, `assumptions` |
| `03-management` | `communication-plan`, `risk-log`, `budget`, `open-questions`, `approval` |
| `04-technical` | `prd`, `architecture`, `api-reference`, `prototype-registry` |
| `05-delivery` | `test-plan`, `deployment`, `acceptance`, `closure` |

Five `docKind`s are per-instance, one file per occurrence inside a folder rather
than a single conventional path: `meeting` (`03-management/meetings/`), `adr`
(`03-management/decisions/`), `change-request`
(`03-management/change-requests/`), `qa-report` (`05-delivery/qa-reports/`),
`release` (`05-delivery/releases/`).

Never hand-write frontmatter. Create every document with
`contrail scaffold <docKind> <path>` (add `--json` when a script reads the
result) — it is the one way to get the schema right, and a producer never
reorganises the tree it writes into.

## Diagram type selection

| The text describes | Use | The reader is asking |
|---|---|---|
| Components/services and how they connect | `architecture` | what talks to what |
| An ordered exchange between participants | `sequence` | what happens, in what order |
| A process with branches, actors or handoffs | `workflow` | who does what, and where it can go wrong |
| Data moving between stores and processors | `dataflow` | where this record came from and where it lands |
| One entity moving through states | `lifecycle` | what state is this in, and what comes next |

## The six rules

1. Any section describing a multi-step process gets a diagram. If you
   numbered the steps in prose, you have already admitted it is a flow.
2. Any section naming three or more components and their relationships gets
   an `architecture` diagram.
3. Any section describing data crossing a system boundary gets a `dataflow`
   diagram.
4. Any section describing an entity's states gets a `lifecycle` diagram.
5. A diagram never replaces the prose that states the *consequence*. The
   picture shows the shape; the sentence says why it matters and what
   breaks. Both, always.
6. Every diagram carries a `summary` that stands alone — a reader who cannot
   see the picture must still learn what it shows.

Write for an agent reading one fragment, not the whole document: no "as
mentioned above" or "see below" — name the section or link it. No "recently"
or "currently" — use an absolute date or version.

## Block syntax

````markdown
```archify {type=workflow, src=./diagrams/tool-call.workflow.json, summary="How a tool call flows from user intent through the policy gate to a durable trace."}
```
````

`type` is one of `architecture`, `workflow`, `sequence`, `dataflow`,
`lifecycle`. `src` resolves relative to the document; the IR lives in that
file, not inline. `summary` is mandatory.

## Before considering a document done

Run `contrail check`. Every finding names the heading or block it fired on
and the fix, including which diagram type fits. Fix errors — a build-breaking
`missing-summary` — before anything else; warnings are guidance, not a gate,
unless the build runs `--strict`.
