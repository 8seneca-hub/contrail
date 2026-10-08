# Ledger

## Subtask 1: `greet(name)` pure function — done
Summary: Added `src/greet.ts` with a pure `greet(name: string): string` returning `Hello, <name>!`, and `tests/greet.test.ts` covering an ordinary name (`Hello, Ada!`) and an empty string (`Hello, !`). No I/O and no validation, matching the spec's purity constraint that name validity is the caller's job.
Decisions: None — the function and tests follow the repo's existing conventions (ESM `.js`-extension import, vitest `describe`/`it`).
Open issues: none
Files: src/greet.ts, tests/greet.test.ts

## Subtask 2: `contrail greet <name>` CLI command, test, README — done
Summary: Added a `greet` branch to `main()` in `src/cli.ts` — `contrail greet <name>` prints `greet(name)` via `console.log` and returns 0, a missing `<name>` prints `Usage: contrail greet <name>` to stderr and returns 2 — plus a `greet <name>` entry in the `help` list and a `contrail greet Ada` line in the README Quick start. Added CLI tests for the success, usage-error, and help-list paths.
Decisions: Imported `greet` from `./greet.js` rather than the plan's `../greet.js` (a path typo — `greet.ts` sits in `src/` beside `cli.ts`). Used a concrete `contrail greet Ada` in the README (matching the block's concrete-example style) rather than the literal `<name>` placeholder. Added a help-text test beyond the two the plan listed, matching the repo's per-command convention.
Open issues: none
Files: src/cli.ts, tests/cli.test.ts, README.md
