# contrail

Write project documentation once, in Markdown. contrail publishes it as a static site for people —
with validated, interactive diagrams — and as `llms.txt` plus the source Markdown for coding agents,
while keeping internal material out of anything a client can see.

> **Status (2026-09-13):** M1 through M4 implemented. 485 tests pass, 1 skipped (the live Plane
> integration test). `npm run typecheck` and `npm run build` are clean. Live verification against a
> real Google Sheet and a real Plane instance has **not** been run — see "What has not been verified".

## What it does

One Markdown file per document. The build parses it once and emits:

| Output | Audience |
|---|---|
| A static site — nested tabbed navigation, interactive Archify diagrams, live spreadsheet ranges | people |
| `docs/llms.txt` plus the source `.md` files | coding agents |
| Plane-safe HTML | dormant — see below |

Two builds come from one source: `contrail site` emits everything, `contrail site --audience client`
emits only documents marked `audience: client`. The internal build carries a red banner on every page
and `(internal)` in its title, so two browser tabs are never confusable.

## The audience boundary

This is the feature with a real cost attached. An agency's budget, effort estimate and margin live in
the same tree as the documents a client reads.

`audience` defaults to `internal`, so a document nobody classified is never publishable to a client.
Marking one `client` is a deliberate act. A client build does not *hide* internal documents — it does
not contain them: no page file, no diagram artifact, no path in `llms.txt`, and links to internal
documents have their `href` stripped, because a URL containing `03-management/budget` is itself a leak.

That absence is why a client site is safe to deploy unprotected. There is nothing on that host to
protect, which is a stronger guarantee than access control and survives a misconfiguration that access
control would not.

## Diagrams

Diagrams are authored as typed [Archify](https://github.com/tt-a1i/archify) IR stored beside the
document, and compiled to self-contained interactive HTML:

````markdown
```archify {type=architecture, src=./diagrams/portal.architecture.json, summary="Shippers and ops reach a Next.js portal backed by a tracking API, which syncs nightly with the legacy TMS."}
```
````

Archify refuses to compile a diagram it cannot guarantee is readable — it rejects overlapping labels,
sublabels below a legible minimum, nodes too close together, and layouts that overflow a real browser
viewport, each with the coordinates to fix it. A published diagram is one a machine has already
confirmed a person can read.

The `summary` is mandatory. It is what an agent reads in place of the picture, and what appears as the
caption. Mermaid blocks still work; Archify is the documented path.

## Quick start

```bash
contrail init --template agency-project   # five-section tree, never overwrites
contrail scaffold adr docs/03-management/decisions/0007-use-postgres.md
contrail check --index                    # lint + regenerate docs/llms.txt
contrail site --out site
```

See [`docs/using-contrail.md`](docs/using-contrail.md) for the full workflow, and
[`docs/deploying.md`](docs/deploying.md) for the two-Vercel-project setup.

## Agent integration

### The one-line setup — no plugin required

Add to the project's `CLAUDE.md`:

```markdown
Project documentation: `docs/llms.txt` is the index of every document — read it before
answering questions about scope, estimates, architecture or past decisions.
```

That is the minimum viable integration, and it works with nothing installed. With `contrail` on
`PATH`, a session can also run `contrail context --task <type>` to narrow forty-four documents down to
the three a task needs — respecting `--audience`, so an agent working for a client never receives an
internal document.

### The plugin — auto-triggering plus slash commands

Installing `plugin/` adds the `contrail-docs` skill, which fires both on documentation work and on
questions that need project context ("is this in scope?", "why did we decide that?"), plus
`/docs-context`, `/docs-new`, `/docs-check` and `/docs-site`.

## Why Plane is dormant

contrail began as a Plane Pages publisher. Live verification found that **Plane Community v1.4.0 does
not expose the Pages API** — `404` on both the workspace and project paths, while `/projects/` returns
`200`. The Pages API ships with the Commercial Edition.

`src/plane/` and `src/emit/plane.ts` remain in the tree, tested and unmodified. They are dormant, not
dead: the publisher, its overwrite guard and its lockfile are correct and will work the day an instance
moves to Commercial Edition. The static site is the delivery target until then.

## What has not been verified

Everything below is implemented and unit-tested, but has never run against the live system:

- **Plane publishing.** `tests/integration/plane-live.test.ts` is skipped unless `PLANE_BASE_URL`,
  `PLANE_WORKSPACE` and `PLANE_API_KEY` are set. `docs/verification.md` is an unfilled template. The
  open question is whether `<image-component src="...">` accepts an uploaded asset's id;
  `imageSrc()` in `src/emit/plane.ts` is the single place to change if not.
- **Google Sheets read/write.** The Sheets API client is injected in tests and has never touched a
  real spreadsheet. It needs a service account and the sheet shared with that account's email.

## Known limitations

- **Archiving a document loses its Plane page for good.** Plane has no unarchive endpoint, so
  re-adding an archived document creates a new page. A rename behaves the same way: the old page is
  archived, a new one created, and comments on the old page are stranded.
- **Vercel protection is not automatic.** Deploying does not protect anything. Vercel Authentication
  covers preview deployments; protecting a production domain requires Pro, configured before the first
  internal deploy. See [`docs/deploying.md`](docs/deploying.md).

## License

MIT
