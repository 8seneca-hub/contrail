# contrail M1.5 — Archify diagrams and the static site

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Diagrams are authored as Archify IR and rendered to self-contained interactive HTML; documents publish to a static site that embeds them in iframes; the agent-facing Markdown carries the prose summary plus a link to the typed IR.

**Architecture:** Archify replaces Mermaid as the documented diagram engine. It is a zero-dependency Node CLI that compiles typed JSON IR to a self-contained HTML artifact in ~0.5s, with a validation receipt. Because Plane Community does not expose the Pages API, the static site becomes the delivery target; `src/plane/` and `src/emit/plane.ts` stay in the tree, tested and dormant, for the day the instance moves to Commercial Edition.

**Tech Stack:** TypeScript (strict, ESM), Node >= 22, the Archify CLI invoked as a subprocess, vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-contrail-design.md` (M1), amended by this plan's Context section.

## Context: what changed since M1, and why

Live verification against the real instance (`projects.8seneca.com`, Plane **Community v1.4.0**) found the Pages REST API absent — `404` on both `/workspaces/{ws}/pages/` and `/workspaces/{ws}/projects/{id}/pages/`, while `/projects/` returns `200`. Plane's own documentation states the Community Edition is "at par with the Free tier"; the Pages API ships with the Commercial Edition. M1's publisher is therefore correct but unreachable on this deployment.

Archify is a better engine than Mermaid for this project on every axis that matters here: 0.5s versus 7.2s cold, zero dependencies versus a headless browser, self-contained output with no external references, and a deterministic receipt carrying a sha256 and validation results.

## Global Constraints

- **Node >= 22.** ESM only; every relative import carries an explicit `.js` extension.
- **TypeScript strict**, `noUncheckedIndexedAccess: true`. `npm run typecheck` covers `src` and `tests`.
- **Never add `archify` as an npm dependency.** The npm package of that name is `justin-calleja/archify` v0.0.4 — an unrelated project. The real Archify (`tt-a1i/archify`, v2.17) is distributed as an agent skill from GitHub and is invoked as a subprocess, exactly as `mmdc` is today.
- **Do not modify `src/plane/` or `src/emit/plane.ts`.** They are dormant, not dead: tested, working, and reachable the moment the instance moves to Commercial Edition.
- **Mermaid support stays.** Existing `mermaid` blocks must keep rendering; Archify is the documented path, not a replacement that breaks published documents.
- **Every diagram block declares a `summary`.** Same invariant as the artifact block, same reason: an agent reading the Markdown must never lose what a human sees.
- Tests never invoke the real Archify binary — inject a fake runner, as `Mmdc` is injected today.

## Authoring format

````markdown
```archify {type=workflow, src=./diagrams/tool-call.workflow.json, summary="How a tool call flows from user intent through the policy gate to a durable trace."}
```
````

`type` is one of `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`. `src` resolves relative to the document. The block body is empty — the IR lives in the referenced file, because it runs to hundreds of lines and inlining it would drown the prose.

## Emitter matrix

| Emitter | Archify block becomes |
|---|---|
| `site` | `<iframe>` embedding the rendered self-contained artifact, with the summary as a caption |
| `md` (agents) | the prose summary, plus a relative link to the IR JSON — typed topology an agent can parse, which is strictly more than a picture |
| `plane` | dormant; unchanged |


## Visualization rules (the point of the milestone)

A document that explains a flow in prose alone has failed at its job. The rules below are what
contrail pushes authors and agents toward, and Task 5 makes them checkable rather than aspirational.

**Map the content shape to the diagram type.** Archify's five types are not stylistic choices; each
answers a different question:

| When the text describes | Use | Because the reader is asking |
|---|---|---|
| Components or services and how they connect | `architecture` | what talks to what |
| An ordered exchange between participants | `sequence` | what happens, in what order |
| A process with branches, actors or handoffs | `workflow` | who does what, and where it can go wrong |
| Data moving between stores and processors | `dataflow` | where this record came from and where it lands |
| One entity moving through states | `lifecycle` | what state is this in, and what comes next |

**The rules themselves:**

1. Any section describing a multi-step process gets a diagram. If you numbered the steps in prose,
   you have already admitted it is a flow.
2. Any section naming three or more components and their relationships gets an `architecture` diagram.
3. Any section describing data crossing a system boundary gets a `dataflow` diagram.
4. Any section describing an entity's states gets a `lifecycle` diagram.
5. A diagram never replaces the prose that states the *consequence*. The picture shows the shape; the
   sentence says why it matters and what breaks. Both, always.
6. Every diagram carries a `summary` that stands alone. A reader who cannot see the picture — an
   agent, or a person on a narrow screen — must still learn what it shows.

---

### Task 1: Archify block parsing and config

**Files:**
- Create: `src/blocks/archify.ts`, `tests/archify-block.test.ts`
- Modify: `src/types.ts` (add `archify` to `Config`), `src/config.ts` (validate it)

**Interfaces:**
- Consumes: nothing from M1 beyond `Config`.
- Produces:
  - `type ArchifyType = 'architecture' | 'workflow' | 'sequence' | 'dataflow' | 'lifecycle'`
  - `interface ArchifyMeta { type: ArchifyType; src: string; summary: string }`
  - `parseArchifyMeta(meta: string | null | undefined, where: string): ArchifyMeta`
  - `class ArchifyBlockError extends Error`
  - `Config.archify?: { bin?: string }` — an optional absolute path to the Archify CLI; when absent, `archify` is resolved from `PATH`.

Reuse the attribute-parsing approach already proven in `src/blocks/artifact.ts`, including its escape handling. Do not duplicate that logic if it can be shared — extract a common attribute parser into a module both import, and say so in your report.

Tests (beyond the obvious): an unknown `type` is rejected naming the allowed set; a missing `summary` is rejected explaining why the summary is mandatory; a missing `src` is rejected; the error message always contains the `where` location; extra unrecognised attributes are ignored.

---

### Task 2: Archify rendering, validation and caching

**Files:**
- Create: `src/render/archify.ts`, `tests/archify-render.test.ts`

**Interfaces:**
- Consumes: `ArchifyMeta`, `ArchifyType` from Task 1.
- Produces:
  - `type ArchifyRunner = (args: string[]) => Promise<{ stdout: string; code: number }>`
  - `interface RenderedArchify { hash: string; htmlPath: string; irPath: string }`
  - `validateArchify(type, irPath, opts): Promise<void>` — throws `ArchifyValidationError` carrying the CLI's own message
  - `renderArchify(type, irPath, cacheDir, opts): Promise<RenderedArchify>`
  - `class ArchifyValidationError extends Error`

Cache by the SHA-256 of the IR file's contents, mirroring `renderMermaid`: on a cache hit no subprocess runs at all. Write the artifact to `<cacheDir>/archify/<hash>.html`.

The CLI contract, verified against v2.17.0-dev.1:
- `archify validate <type> <input.json> --json` — exit non-zero on invalid IR
- `archify render <type> <input.json> <output.html>` — writes a self-contained artifact

Tests: a cache hit invokes the runner zero times; two different IR files produce different hashes; a validation failure throws with the CLI's message included; the runner is never the real binary.

---

### Task 3: Asset collection and the Markdown emitter

**Files:**
- Modify: `src/assets.ts`, `src/emit/md.ts`
- Modify: `tests/assets.test.ts`, `tests/emit-md.test.ts`

`collectAssets` gains archify blocks. An archify diagram is **not** an uploadable image asset — it is an HTML artifact for the site — so it must not be pushed into `AssetPlan` (which exists for Plane uploads and would send an 819KB HTML file to an image endpoint). Add a separate `collectDiagrams(doc, opts): Promise<DiagramPlan[]>` where `DiagramPlan = { id, hash, htmlPath, irPath, meta }`, leaving `collectAssets` unchanged for images.

`emitMarkdown` renders an archify block as the summary paragraph followed by a relative link to the IR file. Preserve the existing non-mutation guarantee — snapshot the input tree in the test, never compare two outputs.

---

### Task 4: The static site emitter and the `site` command

**Files:**
- Create: `src/emit/site.ts`, `templates/site.css`, `tests/emit-site.test.ts`
- Modify: `src/cli.ts`, `tests/cli.test.ts`

**Interfaces:**
- Produces: `emitSite(doc, ctx): string`, `buildSite(args): Promise<SiteResult>`, and a `contrail site [--out <dir>]` command.

The site is plain templated HTML — no framework. Each document becomes one page; each archify diagram is copied into the output as `diagrams/<hash>.html` and embedded:

```html
<figure class="diagram">
  <iframe src="diagrams/<hash>.html" loading="lazy" title="<summary>"></iframe>
  <figcaption><summary></figcaption>
</figure>
```

`loading="lazy"` matters: each artifact is ~800KB, so a page with several diagrams must not fetch them all up front.

Also emit a `index.html` listing every document with its title, summary and status, so the site is navigable.

Tests: a document with two diagrams produces two iframes and two copied files; the summary reaches both the `title` attribute and the caption; a document with no diagrams still renders; HTML special characters in a title or summary are escaped, asserted explicitly.

---

---

### Task 5: `contrail check` — the visualization lint, and the authoring skill

**Files:**
- Create: `src/check.ts`, `tests/check.test.ts`, `plugin/skills/writing-docs/SKILL.md`
- Modify: `src/cli.ts` (wire the `check` command), `tests/cli.test.ts`

**Interfaces:**
- Produces:
  - `interface Finding { doc: string; line?: number; rule: string; message: string; severity: 'warn' | 'error' }`
  - `checkDocs(docs: Doc[], opts?: { strict?: boolean }): Finding[]`
  - a `contrail check [--strict]` command: exit 0 when clean, 1 when `--strict` and any finding exists.

The lint implements the rules above with deliberately conservative heuristics — a noisy linter gets
switched off, which helps nobody. Each rule reports the heading it fired on, so the author knows
exactly where to look.

| Rule id | Fires when | Severity |
|---|---|---|
| `flow-without-diagram` | A heading matching `/flow\|lifecycle\|sequence\|architecture\|pipeline\|process\|journey\|state/i` has no diagram before the next heading of the same or higher level | warn |
| `steps-without-diagram` | An ordered list of four or more items sits in a section with no diagram | warn |
| `undiagrammed-doc` | A document over 400 words contains no diagram at all | warn |
| `missing-summary` | A diagram block has no `summary` | error |
| `stale-doc` | `status: stale` | warn |

Two properties matter more than the heuristics themselves:

- **Every finding names a fix.** `"Section 'Review flow' describes a flow with no diagram — add an
  ```archify block (type=workflow or sequence)"` beats `"missing diagram"`. A lint message that does
  not say what to do is a lint message people learn to ignore.
- **Warnings never fail a build by default.** `--strict` is opt-in, for CI. Documentation tooling that
  blocks a commit over a missing picture trains people to bypass the tool.

`plugin/skills/writing-docs/SKILL.md` carries the same rules in prose, as the guidance an agent reads
before authoring a document: the type-selection table, the six rules, the block syntax, and the
instruction to run `contrail check` before considering a document done.

Tests: each rule fires on a document that violates it and stays silent on one that does not; a section
whose diagram appears after a sub-heading still counts as covered; the `missing-summary` error is
reported as `error` while the rest are `warn`; `--strict` changes the exit code and nothing else.

## Done when

- `npx vitest run` passes and `npm run typecheck` is clean.
- `contrail build` fails loudly on invalid Archify IR.
- `contrail site` produces a browsable directory whose diagrams are interactive.
- The agent-facing Markdown carries every summary and a link to each IR file.
- `contrail check` reports undiagrammed flows with an actionable message, and `--strict` fails CI.
- M1's Plane tests still pass untouched.
