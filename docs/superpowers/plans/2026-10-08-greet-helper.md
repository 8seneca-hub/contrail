# CTR-11 — greet helper (plan)

**Spec:** `docs/superpowers/specs/2026-10-08-greet-helper-design.md`

**Goal:** `greet(name)` pure function + `contrail greet <name>` CLI command, each with a test; one README line. `npm test` passes, `npm run typecheck` is clean.

**Tech stack:** TypeScript (strict, ESM), Node >= 22, vitest. No new dependencies.

## Subtask 1 — `greet()` function + unit test

- Create `src/greet.ts` exporting `greet(name: string): string` returning `` `Hello, ${name}!` ``.
- Create `tests/greet.test.ts`: asserts `greet('World')` → `'Hello, World!'`, and one edge case (`greet('')` → `'Hello, !'`) to pin the exact format.
- Done when: `npx vitest run tests/greet.test.ts` passes and `npx tsc -p tsconfig.test.json` is clean.

## Subtask 2 — `contrail greet <name>` CLI command + test + README

- In `src/cli.ts`, import `greet` from `./greet.js`. Add a `command === 'greet'` branch in `main()`, placed with the other commands that don't need `config` (next to `scaffold`/`init`, before the config-loading block at line ~558).
  - No positional name (`positionals[1]` undefined) → `console.error('Usage: contrail greet <name>')`, return 2.
  - Name present → `console.log(greet(positionals[1]))`, return 0.
  - Add `greet <name>` to the `help` command's printed usage string.
- Extend `tests/cli.test.ts` with cases for `main(['greet', 'World'])` (exit 0, logs the greeting) and `main(['greet'])` (exit 2, usage message), following the existing pattern for asserting `main()`'s console output (spy on `console.log`/`console.error` as other command tests in that file already do).
- Add one line to `README.md`'s Quick start code block: `contrail greet <name>                     # prints "Hello, <name>!"`.
- Done when: `npm test` passes and `npm run typecheck` is clean (full acceptance criteria).

## Final verification

Run `npm test` and `npm run typecheck` at the repo root after both subtasks; both must be clean before this task is considered done.
