# contrail M4 — agent integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** An agent working in a contrail project loads the right documents automatically — because the skill fires on documentation work and on questions that need project context, and because `contrail context` answers "which documents does this task need?" without the agent reading all of them.

**Spec:** extends M2's published schema and M3's site work.

## The problem

A session that needs the scope statement currently depends on someone remembering to mention it. Two failure modes follow, and the second is worse: the agent either reads all forty-four documents and buries the two that matter, or reads none and answers from guesswork with full confidence.

Both are fixed by making document selection a command rather than a judgment call.

## Scope boundary, unchanged

contrail generates and manages documentation. `contrail context` is a **read query over contrail's own tree** — it ranks documents contrail already manages, using metadata contrail already stores. It calls nothing, knows nothing about any other system's state, and works with no other plugin installed. That keeps it inside the boundary.

## Global Constraints

- ESM, explicit `.js` extensions, TS strict. Do not modify `src/plane/`, the Plane overwrite guard, or the Sheets write guard.
- `tests/audience.test.ts` must pass untouched.
- `contrail context` must respect `--audience`: an agent working on a client's behalf must never be handed an internal document.

---

### Task 1: `contrail context`

**Files:** `src/context.ts`, `src/cli.ts`, `tests/context.test.ts`

```
contrail context [--task <type>] [keywords...] [--audience <x>] [--json] [--limit <n>]
```

Returns a ranked list of documents with the reason each was selected, so the agent can read three files instead of forty-four.

**Task types**, from the mapping already documented in `docs/using-contrail.md` — keep the two in sync, and say in the code that they are the same table:

| `--task` | Selects |
|---|---|
| `feature` | prd, architecture, api-reference, adr |
| `estimate` | estimate, assumptions, wbs, scope |
| `scope` | scope, change-request, assumptions |
| `decision` | adr, architecture |
| `client-call` | open-questions, meeting, change-request, scope |
| `onboard` | charter, glossary, architecture, prd |
| `test` | test-plan, qa-report, prd |
| `deploy` | deployment, release, architecture |
| `risk` | risk-log, assumptions, open-questions |

**Ranking within a task type:**
1. `docKind` matches the task's list — earlier entries in the list rank higher, because the table is written in the order a reader needs them.
2. Keyword matches in title, summary or tags add to the score. Keywords alone (no `--task`) are a valid query.
3. `status: current` outranks `draft`; `status: stale` sinks to the bottom and is labelled, never silently dropped — a stale document may still be the only record of something.
4. For collection kinds, recency breaks ties: newest meeting, highest-numbered ADR.

**Output.** Human-readable by default; `--json` gives `{path, title, summary, docKind, status, reason, score}`. The `reason` field matters — an agent that knows *why* a document was selected can tell when the selection was wrong.

Tests: each task type returns its documents in the documented order; keyword-only queries work; a stale document ranks last and is labelled; `--audience client` never returns an internal document (assert on a tree containing both); `--limit` truncates by rank; an empty tree returns an empty result and says so rather than erroring.

---

### Task 2: The auto-triggering skill

**Files:** `plugin/skills/contrail-docs/SKILL.md` (replacing `writing-docs`), `plugin/skills/contrail-docs/reference.md`

The skill's `description` is the trigger. It must fire on two distinct situations, and the current description covers only the first:

1. **Documentation CRUD** — creating, updating, reorganising or removing a document in a contrail tree.
2. **A task that needs project context** — scope boundaries, past decisions, estimates, architecture, open questions. This is the one that matters most, because the agent does not know it is missing context until it has already answered without it.

Write the description to cover both explicitly, naming the document kinds (PRD, ADR, meeting note, scope statement, estimate, change request, QA report, release) and the question shapes ("is this in scope", "why did we decide", "how long will this take"). Be specific: a vague description fires everywhere or nowhere.

**The skill body must be short** — Anthropic's guidance is that context is a public good and the agent is already capable. State the rules; do not explain what documentation is. Cover, in this order:

- **Before answering from memory, run `contrail context`.** This is the first instruction because it is the one that changes behaviour. An agent that has read the right three documents beats one that has read none or all.
- Creating a document: `contrail scaffold <docKind> <path>` — never hand-write frontmatter.
- The title conventions for collection kinds (the table from M3 Task 7).
- Diagram type selection (the five Archify types and what question each answers).
- `contrail check` before considering the work done, and `contrail check --index` when documents were added or removed.
- The audience rule: `internal` is the default; marking something `client` is a deliberate act with a real cost if wrong.

Move anything longer than a table into `reference.md`, which the agent reads only when it needs the detail.

**Deleting a document:** removing the file is correct, but the agent must then run `contrail check --index` so the index does not point at a document that no longer exists. Say so — it is the step people forget.

---

### Task 3: Plugin packaging

**Files:** `plugin/.claude-plugin/plugin.json`, `plugin/commands/*.md`, `README.md`

Package it so it installs as a Claude Code plugin. Commands wrapping the CLI:

| Command | Wraps |
|---|---|
| `/docs-context` | `contrail context` — accepts a task type or free text |
| `/docs-new` | `contrail scaffold` |
| `/docs-check` | `contrail check` |
| `/docs-site` | `contrail site` |

Each command file states what it does in one line and delegates; none reimplements logic that lives in the CLI.

Document installation in `README.md`, including the `CLAUDE.md` line that points a project's sessions at `docs/llms.txt`. That line is the whole integration for a project that does not install the plugin at all, and it should be presented as the minimum viable setup.

---

## Done when

- `contrail context --task scope --json` returns the scope statement and change requests, ranked, with reasons.
- `contrail context --audience client` provably never returns an internal document.
- The skill's description fires on both documentation work and context-needing questions.
- `README.md` explains both setups: the plugin, and the one-line `CLAUDE.md` alternative.

## Not in this milestone

Automatic injection of documents into a session without the agent asking. contrail offers a query; deciding when to run it belongs to the agent and the person driving it.
