# Using contrail

How to run contrail on a real project: when it earns its keep, the commands in the order you
actually need them, and how to hand the resulting documentation to a Claude session later.

## When to use it

Use contrail when documentation has to outlive the conversation that produced it — a client
engagement, a system other people will maintain, anything where someone will ask in three months
"why did we decide that?".

It is worth the setup when at least one of these is true:

- Some documents are internal (budget, margin, risk) and some are for the client. The audience
  boundary is the feature that pays for itself the first time it stops a mistake.
- Agents will need the documentation later. A `docs/` tree with an `llms.txt` index is the
  difference between an agent that answers from your decisions and one that guesses.
- The project has more than a handful of documents, so structure and navigation start to matter.

**Do not use it** for a single README, a throwaway prototype, or a repository where the code is the
documentation. A five-section scaffold around one file is worse than the file.

## Day one

```bash
contrail init --template agency-project
```

Creates the five-section tree with stubs. Then fill in `docs/00-meta/project.yml` — client, project
name, start date. The project name becomes the site title and the `llms.txt` heading, so it is worth
thirty seconds.

`contrail init` never overwrites. Run it again after upgrading contrail and only genuinely new files
appear; everything you have edited is left alone and reported as skipped.

## As the work happens

Create documents through contrail rather than by hand, so the frontmatter is right and the title
follows the convention:

```bash
contrail scaffold meeting docs/03-management/meetings/2026-09-13-sprint-review.md
#   → title: "Sprint review — 13 September 2026"

contrail scaffold adr docs/03-management/decisions/0007-use-postgres.md
#   → title: "ADR 0007 — Use postgres"
```

The derived title is a starting point — `Use postgres` wants to become `Use PostgreSQL` — but the
discriminator (the date, the number) is already in place, which is the part that is tedious and easy
to forget.

Then write the document, and run:

```bash
contrail check
```

Run it before every commit. It is fast, it never blocks by default, and it catches the things that
are invisible while you are writing: a flow described in prose with no diagram, a section that mixes
Diátaxis modes, "recently" where a date belongs, "as mentioned above" in a document an agent will
read one fragment of.

`contrail check --strict` exits non-zero on any finding — use that in CI if you want the discipline,
not on your own machine where it will only make you resent the tool.

## Before sharing anything

```bash
contrail check --index                              # regenerate docs/llms.txt
contrail site --out site                            # internal build, everything
contrail site --out site-client --audience client   # client build, filtered
```

**Regenerating `llms.txt` is not optional.** It is a generated index; if you skip it, agents read a
stale map of your documentation, which is the exact failure contrail warns about elsewhere. Put it in
the same habit as `check` — or in a pre-commit hook.

The two builds are deliberately distinguishable: the internal one carries a red banner on every page
and `(internal)` in its title. If you are ever unsure which tab you are looking at, look at the tab.

## Deploying

Two Vercel projects from one repository — one internal, one client. The client build is safe to leave
unprotected because it does not *contain* internal material; there is nothing on that host to protect.
See [deploying.md](./deploying.md) for the setup, including the protection settings that are **not**
on by default.

```bash
contrail deploy --audience client --prod
```

It refuses to publish an internal build to the client project, and lists every document by title
before a client production deploy. Both guards exist because that mistake is public and has no undo.

## Feeding the documentation to a Claude session

The `.md` files in `docs/` are the agent-facing artifact. There is no export step — the source is the
deliverable. The built site is for people.

### The one-line setup, done once per project

Add to the repository's `CLAUDE.md`:

```markdown
Project documentation: `docs/llms.txt` is the index of every document — read it before
answering questions about scope, estimates, architecture or past decisions.
Documents are the source of truth; the built site under `site/` is generated output.
```

That is the whole integration. Every future session finds the documentation without being told, and
reads only the documents it needs rather than everything.

### Which documents for which task

Pointing an agent at all 44 documents wastes context and buries the two that matter. `contrail
context --task <type>` answers this without a human doing the pointing at all — see "Ask contrail
which documents a task needs" below. **This is the same table `src/context.ts` implements as
`TASK_DOC_KINDS`** — one fact, two homes, one for a person reading this guide and one for the CLI's
`--task` flag. Change one, change both.

| `--task` | Give it (in this order — earlier ones matter more) |
|---|---|
| `feature` | `04-technical/prd.md`, `architecture.md`, `api-reference.md`, the relevant ADRs |
| `estimate` | `02-planning/estimate.md`, `assumptions.md`, `wbs.md`, `scope-statement.md` |
| `scope` | `02-planning/scope-statement.md`, `03-management/change-requests/`, `assumptions.md` |
| `decision` | `03-management/decisions/` (ADRs), `04-technical/architecture.md` |
| `client-call` | `03-management/open-questions.md`, `meetings/` (newest first), `change-requests/`, `scope-statement.md` |
| `onboard` | `01-overview/charter.md`, `glossary.md`, `04-technical/architecture.md`, `prd.md` |
| `test` | `05-delivery/test-plan.md`, `qa-reports/` (newest first), `04-technical/prd.md` |
| `deploy` | `05-delivery/deployment.md`, `releases/` (highest version first), `04-technical/architecture.md` |
| `risk` | `03-management/risk-log.md`, `02-planning/assumptions.md`, `03-management/open-questions.md` |

The `decision` row is worth calling out: because an ADR title states the decision as an assertion, an
agent scanning `llms.txt` often answers a "why" question from the index without opening a file.

### Ask contrail which documents a task needs

```bash
contrail context --task scope
contrail context --task estimate --audience client --json
contrail context pricing contingency   # keywords work with no --task at all
```

Returns a ranked list with a `reason` per document — not just a path, so an agent can tell when the
selection looks wrong. A `status: stale` document is never dropped; it sinks to the bottom of the
list and is labelled, because it may be the only record of something. `--audience client` filters
exactly the way `contrail site --audience client` does — an agent working on a client's behalf never
gets an internal document back from either surface. `--limit <n>` truncates to the top N; `--json`
gives `{path, title, summary, docKind, status, reason, score}` per document.

### In a single session

```
Read docs/llms.txt, then read the estimate and the assumptions register.
I want to know whether the contingency is defensible.
```

### Over HTTP, once deployed

```
https://your-client-site.vercel.app/llms.txt
```

The client site's `llms.txt` is filtered to client-visible documents, so an agent working on the
client's behalf sees exactly what the client sees. Use the internal URL for your own agents.

## What the documentation gives an agent that a site does not

Three properties the design preserves deliberately, and they are the reason to point agents at the
source rather than the HTML:

- **Diagrams as typed IR.** An `archify` block leaves a link to JSON describing exact nodes, edges
  and routes — plus the mandatory prose summary. Strictly more usable than a picture.
- **Spreadsheet values inline.** A `sheet` block renders as a Markdown table, so the agent reads
  *214 days*, not a Google Sheets URL it cannot open.
- **Staleness marked.** A `status: stale` document is labelled `(stale)` in the index, so an agent
  discounts it instead of quoting it back to you with confidence.

## Command reference

| Command | Use |
|---|---|
| `contrail init --template agency-project` | Scaffold the tree. Never overwrites. |
| `contrail scaffold <docKind> <path>` | One document, correct frontmatter and title |
| `contrail build` | Parse and validate everything; fails on broken frontmatter or invalid diagram IR |
| `contrail check [--strict] [--index] [--audience <x>]` | Lint; `--index` writes `llms.txt` |
| `contrail status` | Which documents exist, which are stubs, which lack an owner |
| `contrail context [--task <type>] [keywords...] [--audience <x>] [--limit <n>]` | Ranked documents for a task, with a reason each |
| `contrail site --out <dir> [--audience client]` | Build the site |
| `contrail sheet pull \| push <doc>` | Refresh or write back spreadsheet ranges |
| `contrail deploy [--audience <x>] [--prod] [--dry-run]` | Deploy to Vercel |

## The habit, in one line

```bash
contrail check --index && contrail site --out site
```

Run that before you commit. Everything else is occasional.
