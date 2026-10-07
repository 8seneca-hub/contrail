# contrail_hello — spec

**Goal:** A `contrail_hello` MCP tool, backed by a pure `hello(name)` function, returning
`Hello, <name>!`.

## Why

Smoke-test task for the MCP tool-registration path: smallest possible tool, end to end,
with tests and a typecheck, so the pattern is proven before a real tool reuses it.

## Scope

- `hello(name: string): string` — pure function, no I/O. Returns `` `Hello, ${name}!` ``.
- `contrail_hello` registered as an MCP tool in `src/index.ts`, taking `{ name: string }`,
  calling `hello()`, returning its result as the tool's text content.
- A row in the README `Tools` table (new section — none exists yet) documenting
  `contrail_hello`.
- `src/index.ts` does not currently exist. This spec creates it as the MCP server entry
  point, using `@modelcontextprotocol/sdk` (add as a dependency). `contrail_hello` is the
  only tool registered on it for this task — do not backfill other CLI commands as MCP
  tools, that is out of scope.

## Out of scope

- Any MCP tool other than `contrail_hello`.
- Wiring the MCP server into `package.json` `bin`/`scripts` beyond what's needed to import
  and test it.

## Acceptance

- `npm test` passes (new tests included).
- `npm run typecheck` is clean.
- README has a `Tools` table with a `contrail_hello` row.
