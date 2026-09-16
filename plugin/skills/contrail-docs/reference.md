# contrail docs — reference

Detail that doesn't fit a table in `SKILL.md`. Read this when you need it, not before.

## Frontmatter schema

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
unanswered: string      # optional; why the guiding questions have no answer yet
reviewedOn: "YYYY-MM-DD"  # optional; quote it — unquoted YAML parses as a Date, not a string
---
```

A scaffolded document arrives asking guiding questions. Answering them is the work; `contrail check`
reports each one that is still nothing but its questions (`unanswered-stub`) and `contrail deploy`
refuses while any remain. When the material genuinely does not answer a question, set `unanswered`
to what is missing and what it is blocked on, and record the gap in `open-questions.md`. That is an
answer. Inventing a figure, a name or a date to fill the space is not, and it is the failure the
rule exists to prevent.

Pick one `kind`. Mixing forms in one document — a how-to that stops to explain theory, an
explanation that lists numbered steps — is the most common documentation failure. `contrail check`
flags it (`mixed-mode`) when `kind` is set.

## The audience rule, in full

`audience` is the client-visibility gate, not a convenience field. It defaults to `internal` — a
document nobody has classified is never publishable to a client. Only an explicit `audience: client`
opts a document in; never guess it. A money document (`docKind: budget`/`estimate`, or a path under
`03-management/budget` or `estimate`) marked `audience: client` is a build error
(`internal-doc-exposed`), and one with `audience` left unset at all is *also* an error
(`unclassified-money-doc`) — silence on a money document must be loud. `contrail site --audience
client` and its own `llms.txt`, and `contrail context --audience client`, all emit only what is
explicitly opted in; everything else is simply absent from that surface, not merely unlinked.

## Document taxonomy: `docKind` → `section`

Full schema, including the machine-readable `--json` interface for `scaffold`, `check` and
`status`: `docs/document-schema.md`. Summary — one core file per `docKind` per section:

| Section | `docKind`s |
|---|---|
| `01-overview` | `charter`, `business-case`, `stakeholders`, `domain-research`, `glossary` |
| `02-planning` | `scope`, `wbs`, `schedule`, `estimate`, `assumptions` |
| `03-management` | `communication-plan`, `risk-log`, `budget`, `open-questions`, `approval` |
| `04-technical` | `prd`, `architecture`, `api-reference`, `prototype-registry` |
| `05-delivery` | `test-plan`, `deployment`, `acceptance`, `closure` |

Five `docKind`s are per-instance, one file per occurrence inside a folder rather than a single
conventional path: `meeting` (`03-management/meetings/`), `adr` (`03-management/decisions/`),
`change-request` (`03-management/change-requests/`), `qa-report` (`05-delivery/qa-reports/`),
`release` (`05-delivery/releases/`).

`contrail scaffold meeting|adr|change-request|qa-report|release <path>` derives a starting title
from the filename you choose (a date- or number-prefixed name carries its own discriminator) — edit
it rather than leaving the derived guess if it reads awkwardly. `contrail check` warns
(`title-missing-discriminator`) when one of these five is missing its discriminator; the warning
names the expected pattern.

## The six diagramming rules

1. Any section describing a multi-step process gets a diagram. If you numbered the steps in prose,
   you have already admitted it is a flow.
2. Any section naming three or more components and their relationships gets an `architecture`
   diagram.
3. Any section describing data crossing a system boundary gets a `dataflow` diagram.
4. Any section describing an entity's states gets a `lifecycle` diagram.
5. A diagram never replaces the prose that states the *consequence*. The picture shows the shape;
   the sentence says why it matters and what breaks. Both, always.
6. Every diagram carries a `summary` that stands alone — a reader who cannot see the picture must
   still learn what it shows.

Write for an agent reading one fragment, not the whole document: no "as mentioned above" or "see
below" — name the section or link it. No "recently" or "currently" — use an absolute date or
version. `contrail check` flags both (`dangling-reference`, `relative-time`).

## Block syntax

````markdown
```archify {type=workflow, src=./diagrams/tool-call.workflow.json, summary="How a tool call flows from user intent through the policy gate to a durable trace."}
```
````

`type` is one of `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`. `src` resolves
relative to the document; the IR lives in that file, not inline. `summary` is mandatory
(`missing-summary` is a build error, not a warning).

## Before considering a document done

Run `contrail check`. Every finding names the heading or block it fired on and the fix, including
which diagram type fits. Fix errors — a build-breaking `missing-summary` — before anything else;
warnings are guidance, not a gate, unless the build runs `--strict`.

Added or removed any document (a new meeting note, a deleted ADR that got superseded, a rename):
run `contrail check --index` to regenerate `docs/llms.txt`. Skipping this is the failure mode
`contrail` exists to prevent in miniature — an index describing documents that no longer match
disk, which is worse than no index at all because an agent trusts it.
