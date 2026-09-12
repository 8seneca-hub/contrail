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
kind: tutorial | how-to | reference | explanation   # optional, Diátaxis
---
```

Pick one `kind`. Mixing forms in one document — a how-to that stops to explain
theory, an explanation that lists numbered steps — is the most common
documentation failure. `contrail check` flags it when `kind` is set.

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
