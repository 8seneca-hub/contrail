## Subtask 1: the pure function — done
Summary: Added `src/greet.ts`, exporting `greet(name: string): string` as a single template interpolation returning `Hello, <name>!`, and `tests/greet.test.ts` covering a plain name and an empty string. The implementation matches the plan verbatim and the two tests pass (`vitest run tests/greet.test.ts`, 2 passed).
Decisions: None material — the function body is verbatim from the plan. The test names are descriptive prose ("greets a name", "interpolates an empty string rather than judging it") that state the intent the plan gives in prose.
Open issues: none
Files: src/greet.ts, tests/greet.test.ts

## Subtask 2: the greet command — done
Summary: Added the `greet` branch to `main()` in `src/cli.ts` above the `loadConfig(findConfigPath(process.cwd()))` line, plus the `greet.js` import and `greet <name>` in the `help` usage string; appended a `describe('greet command (via main)')` block to `tests/greet.test.ts`; and added the greet line to the README Quick start block. Verified: `vitest run tests/greet.test.ts` — 4 passed; `npm run typecheck` — exit 0, clean.
Decisions: Placed the branch above the config load so `greet` works outside a contrail tree, per the spec's placement constraint; used exit code 2 with `Usage: contrail greet <name>` on stderr for a missing positional, matching `scaffold`/`sheet`.
Open issues: none
Files: src/cli.ts, tests/greet.test.ts, README.md
