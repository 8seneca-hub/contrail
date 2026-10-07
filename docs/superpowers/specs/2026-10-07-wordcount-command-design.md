# CTR-5: `wordcount` command — design

**Status:** approved for implementation (bounded change, no architectural impact).

## Why

contrail is a documentation CLI. Authors sometimes want a quick word count on a
document (budget estimates, review turnaround, "is this doc too long"). This adds
a small, self-contained `wordcount` command to the existing CLI.

## Scope

Three parts, each independently testable:

1. A pure `countWords(text: string): number` function.
2. The `contrail wordcount <file>` CLI command, wired to it.
3. A short README section documenting the command.

No new dependencies. No config changes. No interaction with Plane, Sheets, or the
docs pipeline — this command reads one file and prints a number.

## Design

### 1. `src/wordcount.ts`

```ts
export function countWords(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  return trimmed.split(/\s+/).length
}
```

Pure, no I/O. Splits on runs of whitespace (space, tab, newline). Empty or
whitespace-only input counts as 0 words — there is no "word" to count, and a
result of 1 for an empty file would mislead whoever reads it.

### 2. `src/cli.ts` — `wordcount` command

Add a `wordcount` branch to `main()`, alongside `scaffold` (same positional-arg
shape: `contrail wordcount <file>`):

- `positionals[1]` is the file path, resolved against `process.cwd()`.
- Missing path argument → usage error, exit 2 (matches `scaffold`'s missing-arg
  handling).
- Read the file with `readFileSync(path, 'utf8')`. If the file does not exist or
  can't be read, catch the error and print a clear message naming the path
  (matches the `Never catch (e) { throw new Error(e.message) }` /
  "error messages tell the operator what happened" rule) — exit 1.
- On success: `console.log(\`${count} word(s) in ${path}\`)`, exit 0.
- Add `wordcount <file>` to the `help` command's usage string.

This command does not touch `config`, `allDocs`, or any Plane/Sheets state, so it
is handled before the `loadConfig(...)` call that every docs-aware command
depends on — a user should be able to word-count a file without a `contrail.config.ts`
present.

### 3. Tests

- `tests/wordcount.test.ts` (new): unit tests for `countWords` —
  - empty string → 0
  - whitespace-only string → 0
  - single word → 1
  - multiple words separated by single spaces
  - words separated by multiple spaces, tabs, and newlines (mixed)
  - leading/trailing whitespace is ignored
- `tests/cli.test.ts` (existing file, add a `describe('wordcount command')`
  block, following the file's existing pattern of `mkdtempSync` + `writeFileSync`
  for fixtures):
  - counts words in a temp file and prints the count
  - missing file → non-zero exit and an error naming the path
  - missing positional argument → usage error, exit 2

### 4. README

Add a short "## Word count" section (after "Quick start", before "Agent
integration"), one example:

```bash
contrail wordcount docs/03-management/proposal.md
```

## Out of scope

- No `--json` output, no glob/multi-file support, no stdin support. YAGNI — the
  ticket asks for a file-in, number-out command, not a batch tool. Add these only
  if someone asks.
- No integration with `contrail check` or the docs pipeline.

## Risks

None of architectural weight. The only subtlety is the empty-input edge case
(0, not 1), which is called out explicitly above and covered by a test.
