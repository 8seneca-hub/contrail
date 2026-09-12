# contrail — design

**Date:** 2026-09-12
**Status:** approved, pre-implementation

## Problem

Teams using [Plane](https://plane.so) want its Pages feature to be their Confluence: the
place project documentation lives. Two audiences read that documentation and they want
opposite things.

- **Humans** read better with structure and pictures — diagrams, flows, tables, callouts.
- **Agents** read better with plain Markdown on disk: greppable, diffable, reviewable.

Maintaining both by hand guarantees drift. contrail generates both from one source, and
keeps the pair in sync over the life of the document — including when decisions arrive
after the document was written.

## Goals

1. One Markdown source of truth, in git, reviewable in merge requests.
2. Rich, readable rendering in Plane Pages — diagrams included.
3. A fully interactive HTML version for documents that need more than Markdown can express.
4. Agents consume the Markdown directly, with no export step.
5. Documents absorb later decisions and discussion without silently going wrong.

## Non-goals

- Bidirectional sync. Publishing is one-directional; inbound changes become reviewed git diffs.
- A search index, vector database, or documentation MCP server. The files are on disk.
- Replacing Plane's editor for ad-hoc notes. contrail owns generated documents only.

## Verified platform constraints

Established against Plane's API reference and product docs, not assumed:

| Fact | Consequence |
|---|---|
| Pages REST API supports create / read / update / archive / delete, for both project pages and workspace wiki pages | Publishing is a supported integration, not a scrape |
| `description_html` **replaces the entire page body** on update | Every publish renders the whole document; partial patching is impossible |
| Plane sanitizes HTML into its editor schema. `<style>`, `<script>`, `<svg>`, `<iframe>`, arbitrary `<div>` are stripped | A self-contained interactive artifact **cannot** live inside a page body |
| Allowed: headings, lists, task lists, tables, code blocks, blockquote, `<img>`, links, plus Plane components — callout, image, work-item embed, page embed, math, attachment | This set is the entire Plane rendering budget |
| Max `description_html` payload: 10 MB | Check before write, fail with a clear message |
| Asset upload requires `entity_identifier = PAGE_UUID` | A page must exist before its images — publishing is inherently two-phase |
| `<img src>` accepts external URLs | Tempting, but see below |
| **Work item comments: full CRUD API. Page comments: no API endpoints on any tier.** | Inbound discussion rides work items, not page comments |
| Webhooks exist | Real-time capture is possible later; it needs a receiver service |
| HTML artifact block, Embed block, Draw.io are paid-tier features | Community tier renders diagrams as images only |

Two consequences worth stating plainly:

- **Diagrams must be uploaded as Plane assets, not hot-linked.** An externally hosted image
  behind access protection fails to load cross-origin without the viewer's session cookie.
  Plane-hosted assets share the reader's existing auth and always render.
- **Interactive artifacts live outside Plane** on a static host, linked from the page.

## Architecture

### One source, three emitters

`docs/**/*.md` is the only authored artifact. The build parses each file once into a syntax
tree, then emits three ways:

| Emitter | Output | Audience |
|---|---|---|
| `md` | the file itself, plus a generated `INDEX.md` | agents |
| `plane` | Plane-safe HTML subset, diagrams as uploaded assets | the team, in Plane |
| `html` | static site with live diagrams, nav, TOC, search | the team, when they need to explore |

### Document format

```yaml
---
title: Settlement flow
summary: One paragraph. Feeds INDEX.md and the Plane page excerpt.
status: draft | review | current | stale
repos: [billing, ledger]
tags: [settlement, reconciliation]
decisions: [7, 12]
watch: [PROJ-123]
plane: { collection: Engineering/Flows, parent: flows/README }
---
```

`status` is load-bearing. A stale document that an agent treats as current is worse than a
missing one, so staleness is tracked, surfaced in Plane, and marked in the agent index.

### Block semantics

| Syntax | `html` | `plane` | `md` |
|---|---|---|---|
| ` ```mermaid ` | inline SVG, pan/zoom | rendered PNG asset → `<image-component>` | fenced source |
| ` ```artifact {fallback, summary} ` | live interactive markup | fallback image + summary prose | fallback reference + summary |
| `> [!NOTE]` / `[!WARNING]` | styled callout | callout component | unchanged |
| `@repo/path/file.ts:42` | source permalink at pinned commit | same | same |
| `PROJ-123` | link | `<issue-embed-component>` | link |

**Invariant:** an `artifact` block without both `fallback` and `summary` fails the build.
This is the mechanism that prevents drift — the interactive version can be arbitrarily rich,
but it can never contain information that the Markdown readers cannot see. Agents never go
blind on a document just because a human made it pretty.

Mermaid renders once per diagram to both `.svg` (site) and `.png` (Plane). No client-side
diagram library; the site ships static SVG with a small zoom control.

### Configuration and multi-repo workspaces

A workspace folder frequently holds several repositories, and the most valuable documents —
end-to-end flows — describe how those repositories interact, so they belong to none of them.
`contrail.config.ts` therefore sits at the **workspace** root and is found by walking up from
the current directory. Running the CLI from inside one repository still publishes into the
correct place.

```ts
export default {
  plane: {
    baseUrl: 'https://plane.example.com',
    workspace: 'acme',
    collection: 'Engineering',
  },
  repos: {
    billing: './billing-service',
    ledger:  './ledger-service',
  },
  docs: ['./docs/**/*.md', './*/docs/**/*.md'],
  site: { host: 'vercel' },
}
```

The `repos` map is what makes `@billing/src/Invoice.ts:42` resolve to a source permalink
pinned at the commit that was checked out when the document was built.

### State

`contrail.lock.json`, committed to git:

```
doc path → { pageId, contentHash, assetIds, issueUuids, repoCommits, archived? }
```

Unchanged documents are skipped. A deleted document **archives** its page rather than
deleting it, and the lock entry is retained so that re-adding the document restores the same
page instead of creating a duplicate.

## Plane publisher

```
pageId ??= POST /workspaces/{ws}/pages/          # stub body
for each changed asset:
    POST /workspaces/{ws}/assets/                # entity_type: PAGE_DESCRIPTION
    PUT bytes → upload_data.url
    POST confirm
PUT   page { name, description_html: emitPlane(doc, assetIds) }   # PUT replaces the whole body
```

Collection placement happens on create only, so manual reorganization in Plane survives
republishing.

### Guards

- Payload size checked against the 10 MB ceiling before write.
- Page hierarchy uses Plane's native `parent_id` / `collection_id` on create (they are mutually
  exclusive), not embedded sub-page components. Creating a child may return `202`, meaning the
  page exists while its parent link is still being made; that is success, not failure.
- Concurrency capped at 4 in-flight requests; self-hosted instances are not a CDN.
- `PLANE_API_KEY` read from the environment only, never from config.
- **Refuse to overwrite a page edited by a human in Plane** — detected by comparing the
  remote body hash against the lock — unless `--force`. Because an update replaces the whole
  body, skipping this guard means silently destroying a colleague's edit. This is the one
  rule in the system that exists purely to prevent data loss.
- A failed work-item UUID lookup degrades to a plain link with a warning; it never fails a build.

## Artifact site

Static HTML, one file per document, plus a navigation tree and a `search.json` consumed by
client-side fuzzy search. No framework and no server: the emitter already produces HTML, and
a documentation site is not a reason to adopt a build system.

Deployed to Vercel with Deployment Protection enabled. Each Plane page opens with a callout
linking its interactive counterpart.

**Accepted friction:** protected deployments require each reader to hold an account on the
Vercel team. If that cost proves too high, GitLab Pages substitutes at the deploy step alone —
the emitter is unchanged. Only one host is implemented now.

## Document lifecycle

The hard part is not publishing a document. It is what happens three weeks later when a
decision lands in a discussion and the document quietly becomes wrong.

**Principle: inbound never rewrites prose automatically.** Captured material lands in an
inbox; an agent proposes a change; a human reviews the diff; publishing follows. Letting a
chat message rewrite documentation directly is the fastest available route to confidently
wrong documentation — which then propagates into every agent that reads it. Review is the
gate, and the team already reviews merge requests.

### Inbound sources

| Source | Command |
|---|---|
| A decision made during an agent session | `contrail note "we decided X" --doc <path>` |
| Discussion on a watched work item | `contrail capture --work-items` |
| Someone edited the page directly in Plane | `contrail capture --plane-edits` |
| Meeting notes or a transcript | `contrail note --file notes.md --doc <path>` |

The third source is the interesting one: it converts the overwrite guard from a refusal into
a feature. A teammate can edit in Plane, and their edit returns as a proposed Markdown change
rather than being clobbered or forking the truth. The convenience of bidirectional editing,
without the reconciliation problem.

Inbox entries live at `.contrail/inbox/<doc>/<timestamp>-<source>.md` and are committed, so the
merge request that changes a document also shows what prompted the change.

### Decisions are ADRs

`docs/decisions/NNNN-title.md`, with `status: proposed | accepted | superseded-by: NNNN`.
The supersession chain is the lifecycle. A document's `decisions:` frontmatter renders a
"Decisions affecting this page" block with status badges in all three emitters. ADRs are a
solved format and contrail does not invent another one.

### Applying

`contrail apply <doc>` — or `/docs-apply` from the plugin — has an agent read the inbox, the
current document, and its linked ADRs, then produce exactly one of: a new ADR, a prose edit,
or a decision that no documentation change is needed. The output is always a git diff.
Applied entries move to `.contrail/inbox/applied/`.

### Staleness

Documents rot because code moves, not only because decisions land.

- `@repo/path:line` references pin a commit. `contrail check` re-resolves them and flags
  `stale-candidate` when the referenced source has changed since the pin.
- A document whose `updated` date is old and whose watched work items have all closed is flagged.
- `status: stale` renders a warning callout in Plane and a marker in `INDEX.md`, so agents
  discount the document rather than trusting it.

Each published page carries a footer callout: source path, last updated, status, open inbox
count, and applied ADRs — making rot visible in the place people actually read.

**Webhooks are deferred.** Plane supports them and they would make capture real-time, but
they require a receiving service. Polling covers the need; a receiver later substitutes
behind the same inbox interface.

## Feeding agents

The Markdown is already on disk, so there is nothing to export. contrail adds a generated
`docs/INDEX.md` — one line per document giving path, title, summary, tags, status, and
repositories — as the map an agent reads first. `contrail check` keeps stale content flagged
before an agent ingests it.

No vector database, no retrieval service, no MCP server.

## Surface

```
contrail init | new <path> | build | check | status
contrail publish  [--dry-run] [--only <glob>] [--force]
contrail note     "text" | --file <path>   --doc <path>
contrail capture  [--work-items] [--plane-edits]
contrail apply    <doc>
```

The Claude Code plugin is a thin wrapper: one skill describing the authoring rules and block
semantics, and the commands `/docs-new`, `/docs-check`, `/docs-publish`, `/docs-apply`, each
shelling out to the CLI.

## Stack

TypeScript. `unified` / remark / rehype for parsing and emission — `rehype-sanitize`
configured with Plane's allowed-tag list *is* the Plane emitter's safety net, at no cost.
`@mermaid-js/mermaid-cli` for diagram rendering, cached by diagram hash because it drives a
headless browser and is the slowest step by an order of magnitude. Plain templated HTML for
the site.

## Testing

- **Golden-file tests** for every block type across all three emitters. The emitters are pure
  functions from tree to string, which makes this both cheap and the real correctness surface.
- **Sanitizer conformance:** emitted Plane HTML is run through Plane's allowed-tag schema and
  asserted to survive unchanged. This catches the day Plane tightens its list.
- **Idempotency:** publishing twice performs zero writes on the second run.
- **Overwrite guard:** a simulated remote edit blocks the write and `--force` overrides it.
- Plane client integration tests run against a real instance behind an environment flag, mocked otherwise.

## Milestones

| | |
|---|---|
| **M1** | Config, parsing, `md` and `plane` emitters, mermaid rendering, publisher, lockfile. Documents reach the Plane wiki with diagrams. Independently useful. |
| **M2** | HTML site, Vercel deployment, interactive-version callout. |
| **M3** | Lifecycle: inbox, `note`, `capture`, ADRs, `check` and staleness, `INDEX.md`. |
| **M4** | Claude Code plugin wrapper. |

## Open questions

- Which source-host permalink formats to support beyond GitHub and GitLab.
- Whether `contrail apply` should run the agent itself or only emit a prompt for one.
- Retention policy for `.contrail/inbox/applied/`.
