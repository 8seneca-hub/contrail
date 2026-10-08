# CTR-11 — greet helper (design)

**Goal:** a pure `greet(name)` function usable by code and a `contrail greet <name>` CLI command that prints it, both covered by tests.

**Scope:** additive only. No existing command, type, or file changes beyond `src/cli.ts`'s dispatch and `README.md`'s Quick start block.

## Function

`src/greet.ts`

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`
}
```

Pure, no I/O, no validation — `name` is trusted input from an internal caller (CLI arg already resolved to a string). No new types needed.

## CLI command

`contrail greet <name>` in `src/cli.ts`'s `main()`, alongside the other simple commands (`build`, `status`):

- No positional `name` → usage error, exit code 2, matching the existing `scaffold`/`sheet` usage-error shape.
- Positional present → `console.log(greet(name))`, exit code 0.
- Added to the `help` command's command list string.

This command needs no `config`/`allDocs` — it is dispatched before the config-loading block, same placement as `init`/`scaffold`/`deploy`.

## Tests

- `tests/greet.test.ts` — unit test for `greet()`: returns `"Hello, <name>!"` for a normal name; one edge case (empty string) to pin the exact format.
- `tests/cli.test.ts` — extend with `contrail greet <name>` cases: prints the greeting and returns 0; missing arg returns 2 with a usage message.

## Docs

`README.md` Quick start block gets one line:

```
contrail greet <name>                     # prints "Hello, <name>!"
```

## Acceptance

- `npm test` passes.
- `npm run typecheck` is clean.
