# CTR-12 — greet helper and `contrail greet` command

**Spec:** `docs/superpowers/specs/2026-10-08-greet-cli-design.md`

---

### Task 1: `greet(name)` pure function

**Files:**
- Create: `src/greet.ts`, `tests/greet.test.ts`

**Interfaces:**
- Produces: `export function greet(name: string): string` returning `` `Hello, ${name}!` ``.

Tests: returns the greeting for an ordinary name; returns it for an empty string (`"Hello, !"`) — no
validation, since `greet` is a pure formatter and name validity is not its job.

---

### Task 2: `contrail greet <name>` CLI command, test, README

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`, `README.md`

**Interfaces:**
- Produces: a `greet` branch in `main()`: `contrail greet <name>` prints `greet(name)` via
  `console.log` and returns `0`; missing `<name>` prints `Usage: contrail greet <name>` to stderr and
  returns `2`.
- Add `greet` to the `help` command's command list, same line format as the others.
- README: one line under "Quick start" showing `contrail greet <name>`.

Import `greet` from `../greet.js` in `src/cli.ts` (ESM relative import needs the `.js` extension, per
the rest of the file).

Tests (in `tests/cli.test.ts`, alongside the other `main()` command tests): `contrail greet Ada` logs
`Hello, Ada!` and returns 0; `contrail greet` with no name returns 2 and prints usage to stderr.

## Done when

- `npm test` passes.
- `npm run typecheck` is clean.
- `contrail greet Ada` run locally prints `Hello, Ada!`.
