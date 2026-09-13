# contrail

Generate project documentation once, in Markdown. Publish it to [Plane](https://plane.so)
Pages for people to read, and to a static site for the documents that need to be explored
rather than read — while the Markdown stays on disk, in git, as the thing coding agents
consume.

> **Status:** M1 (the publish spine) is implemented and tested; live verification against a
> real Plane instance has not yet been run. See [the design document](docs/superpowers/specs/2026-09-12-contrail-design.md).

## Why

Plane Pages make a good team wiki, and Markdown in git makes good agent input. Keeping both
by hand guarantees they drift apart. contrail derives both from one source and keeps them
aligned over the life of the document — including when a decision arrives weeks after the
document was written.

## How it works

One Markdown file per document. The build parses it once and emits three ways:

| Output | Audience |
|---|---|
| the Markdown itself, plus a generated index | coding agents |
| Plane-safe HTML, diagrams uploaded as page assets | the team, in Plane |
| a static site with live diagrams, navigation and search | the team, when exploring |

Mermaid diagrams render to images for Plane and to scalable SVG for the site. Blocks that
need real interactivity are allowed — but only if they also declare a static fallback and a
prose summary, so a document can never contain something the Markdown readers cannot see.

Documents absorb later decisions through an inbox rather than by direct rewriting: captured
discussion, work-item comments and edits made in Plane all become proposed git diffs that a
human reviews before they are published. Decisions themselves are ADRs, with a supersession
chain.

## Constraints worth knowing up front

contrail is shaped by what Plane actually permits, verified against its API:

- Updating a page **replaces the entire body**, so every publish renders the whole document,
  and contrail refuses to overwrite a page a human has edited in Plane unless forced.
- Plane sanitizes HTML into its editor schema, so a self-contained interactive artifact
  cannot live inside a page. It lives on the static site and the page links to it.
- Page images must be uploaded as Plane assets rather than hot-linked, because an
  access-protected external image will not load for readers.
- Plane exposes work item comments through its API, but not page comments — so inbound
  discussion is captured from work items.

## Live verification

Every automated test runs without a network. One test does not:
`tests/integration/plane-live.test.ts` publishes a real page to a real Plane workspace to
settle what only a live instance can settle — above all, whether Plane's
`<image-component src="...">` actually renders an uploaded asset referenced by its id. It is
skipped automatically (`describe.skipIf`) unless all three environment variables below are
set, so `npx vitest run` stays green with no Plane access at all.

To run it:

```bash
PLANE_BASE_URL=https://plane.yourcompany.com \
PLANE_WORKSPACE=your-workspace \
PLANE_API_KEY=your-key \
npx vitest run tests/integration/plane-live.test.ts
```

The test logs the created page's id and URL to the console **before** any assertion runs, so
the page is still there to inspect even if an assertion fails (the page is archived in a
`finally` block regardless of outcome).

**The test passing is necessary but not sufficient.** Its assertions only prove the emitted
markup — image component, body text, callout, table — survived Plane's HTML sanitizer intact.
They cannot prove the diagram image actually resolves in a browser. After the test passes,
open the logged page URL yourself and confirm the mermaid diagram renders as a picture rather
than a broken image icon. If it is broken, `imageSrc()` in `src/emit/plane.ts` is the single
place to change: try the asset's `asset_url` (from `createAssetUpload`) instead of the bare
asset id.

Record what you find in `docs/verification.md` — it is currently an unfilled template, since
this has not yet been run against a real instance.

## Deploying

`contrail deploy [--audience client|internal] [--prod] [--dry-run] [--yes]` builds the site
and shells out to the Vercel CLI, which owns authentication end to end — contrail never reads,
stores, or logs a token. See [`docs/deploying.md`](docs/deploying.md) for the full first-day
setup: creating the two Vercel projects (internal and client) from this one repository,
configuring `vercel.internalProject`/`vercel.clientProject`, and the guard that refuses to
publish an internal build to the client project (or vice versa).

## Agent integration

Two setups, in order of effort. Both point an agent at the same thing: `docs/llms.txt`, plus
`contrail context` to pick the two or three documents a task actually needs instead of all
forty-four.

### The one-line setup — no plugin required

Add one line to the project's `CLAUDE.md`:

```markdown
Project documentation: `docs/llms.txt` is the index of every document — read it before
answering questions about scope, estimates, architecture or past decisions.
Documents are the source of truth; the built site under `site/` is generated output.
```

**That line is the minimum viable integration.** It works with no plugin installed, in any
project a contrail tree lives in. Every session finds the documentation without being told and,
with `contrail` on `PATH`, can run `contrail context --task <type>` itself to narrow down which
documents to read. See [`docs/using-contrail.md`](docs/using-contrail.md) for the full guide,
including the task-to-document table `contrail context` implements.

### The plugin — auto-triggering, plus slash commands

Installing `plugin/` as a Claude Code plugin adds:

- **The `contrail-docs` skill**, which fires on two situations without being asked: authoring or
  reorganising a document (a PRD, ADR, meeting note, scope statement, estimate, change request,
  QA report, release, ...), and a question that needs project context ("is this in scope?", "why
  did we decide that?", "how long will this take?") — the second is the one that matters, because
  an agent doesn't know it's missing context until it has already answered without it.
- **Four commands** that wrap the CLI directly — none reimplements logic that lives in `src/`:

  | Command | Wraps |
  |---|---|
  | `/docs-context` | `contrail context` — accepts a task type or free-text keywords |
  | `/docs-new` | `contrail scaffold` |
  | `/docs-check` | `contrail check` |
  | `/docs-site` | `contrail site` |

Install it the way any local Claude Code plugin installs — point Claude Code at this
repository's `plugin/` directory. The plugin is worth it once an agent works across many
sessions or many people share the project; the one-line `CLAUDE.md` addition above is what makes
it work at all, with or without the plugin installed.

## Known limitations

- **Archiving a document loses its Plane page for good.** Plane's verified endpoint set has
  no unarchive call, so re-adding a document whose lock entry is archived creates a **new**
  Plane page rather than restoring the old one. Renaming a document behaves the same way:
  contrail sees it as one document archived and a different one created, so the old page is
  archived, a new page is created for the new name, and any comments on the old page are
  stranded on a page nobody will look at again.

## Status

M1, the publish spine, is implemented: the `contrail init | build | status | publish
[--dry-run] [--force] [--only <substring>]` CLI works end to end against the fake Plane
client — parsing documents, rendering Mermaid diagrams, emitting Plane-safe HTML, uploading
page assets, and maintaining the lockfile that guards against overwriting human edits and
recovers from a crash mid-publish. 178 tests pass (1 skipped — see "Live verification"
above), and both `npm run typecheck` and `npm run build` are clean. What has **not** happened
yet is live verification: nobody has run `tests/integration/plane-live.test.ts` against a
real Plane instance, so whether Plane accepts and renders what contrail sends it (see "Live
verification" above) remains unconfirmed. The static site (M2) and the decision-inbox
workflow are not yet built; see the milestones in the design document.

## License

MIT
