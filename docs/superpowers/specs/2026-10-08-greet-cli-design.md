# CTR-12 — greet helper and `contrail greet` command

**Goal:** A pure `greet(name)` helper returning `"Hello, <name>!"`, and a `contrail greet <name>` CLI
command that prints it. Smoke-test task for the release pipeline.

**Architecture:** One new pure function module (`src/greet.ts`), consumed by a new branch in the
existing `main()` dispatcher in `src/cli.ts` — same shape as every other subcommand there (`init`,
`scaffold`, etc.). No new dependencies, no config, no state.

**Tech Stack:** TypeScript (strict, ESM), Node >= 22, vitest. Matches the rest of the repo.

**Plan:** `docs/superpowers/plans/2026-10-08-greet-cli-plan.md`

## Global Constraints

- `greet` is pure: `(name: string) => string`, no I/O, no side effects.
- The CLI command is a thin wrapper: parse the positional, call `greet`, `console.log` the result.
- Follow the existing `main()` pattern in `src/cli.ts` (positionals, early return with an exit code)
  rather than introducing a new dispatch mechanism.
- Usage error (missing `<name>`) prints a `Usage:` line to stderr and returns exit code 2, matching
  `scaffold`'s and `sheet`'s existing usage-error handling.

## Done when

- `npm test` passes, including a unit test for `greet()` and a CLI test for `contrail greet <name>`.
- `npm run typecheck` is clean.
- README documents `contrail greet <name>`.
