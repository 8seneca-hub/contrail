# Ledger

## Subtask 1: `greet(name)` pure function — done
Summary: Added `src/greet.ts` with a pure `greet(name: string): string` returning `Hello, <name>!`, and `tests/greet.test.ts` covering an ordinary name (`Hello, Ada!`) and an empty string (`Hello, !`). No I/O and no validation, matching the spec's purity constraint that name validity is the caller's job.
Decisions: None — the function and tests follow the repo's existing conventions (ESM `.js`-extension import, vitest `describe`/`it`).
Open issues: none
Files: src/greet.ts, tests/greet.test.ts
