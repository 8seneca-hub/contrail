# CTR-5: `wordcount` command — implementation plan

Spec: [`docs/superpowers/specs/2026-10-07-wordcount-command-design.md`](../specs/2026-10-07-wordcount-command-design.md)

Each subtask is independently buildable and testable. Run `npm test` and
`npm run typecheck` after each subtask; both must be clean before moving on.

## Subtask 1 — `countWords` with unit tests

- Create `src/wordcount.ts` exporting `countWords(text: string): number` exactly
  as specified (trim, split on `/\s+/`, empty/whitespace-only → 0).
- Create `tests/wordcount.test.ts` covering: empty string, whitespace-only
  string, single word, multiple space-separated words, mixed
  tabs/newlines/multiple-spaces, leading/trailing whitespace.
- Done when: `npm test -- wordcount` passes, `npm run typecheck` clean.

## Subtask 2 — CLI command wired to `countWords`, with a CLI test

- In `src/cli.ts`, add a `wordcount` branch to `main()`: read `positionals[1]`
  as the file path (usage error, exit 2, if missing — same shape as the
  `scaffold` command's missing-arg handling just above it), resolve against
  `process.cwd()`, `readFileSync(path, 'utf8')`, call `countWords`, print
  `${count} word(s) in ${path}`, exit 0. On a read failure (e.g. ENOENT), print
  a message naming the path and the underlying reason, exit 1 — no bare
  `error.message` rethrow, match the existing catch blocks in this file (e.g.
  the `login` command's catch).
- Add `wordcount <file>` to the `help` command's usage string.
- In `tests/cli.test.ts`, add a `describe('wordcount command')` block (follow
  the file's existing `mkdtempSync`/`writeFileSync` fixture pattern): happy
  path (temp file, assert printed count and exit 0), missing file (exit 1,
  stderr names the path), missing positional (exit 2).
- Done when: `npm test -- cli` passes, `npm run typecheck` clean, and manually
  running `node dist/cli.js wordcount <some file>` after `npm run build` prints
  a correct count.

## Subtask 3 — README section

- Add a `## Word count` section to `README.md`, placed after "Quick start" and
  before "Agent integration", with one example command
  (`contrail wordcount docs/03-management/proposal.md`) and one sentence on
  what it's for.
- Done when: the section reads correctly in isolation (no assumed context from
  surrounding sections) and the example command is one that would actually
  work against this repo's own `docs/` tree.

## Final verification (after subtask 3, done by the coordinator, not this session)

- `npm test` and `npm run typecheck` clean from a fresh checkout.
- `npm run build && node dist/cli.js wordcount README.md` prints a sane count.
- `npm run build && node dist/cli.js wordcount does-not-exist.md` exits
  non-zero with a clear message.
- `node dist/cli.js help` lists `wordcount`.
