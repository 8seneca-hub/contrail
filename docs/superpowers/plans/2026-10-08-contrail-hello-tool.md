# contrail_hello tool

**Spec:** `docs/superpowers/specs/2026-10-08-contrail-hello-tool.md`

**Goal:** `contrail_hello` MCP tool, backed by a pure `hello(name)`, returning
`Hello, <name>!`.

## Global constraints

- ESM, explicit `.js` extensions in relative imports, TS strict (matches rest of `src/`).
- Do not touch `src/plane/`, `src/emit/plane.ts`, or any other existing module.
- `npm test` and `npm run typecheck` must stay green after each subtask.

---

### Subtask 1: `hello(name)`

**Files:** `src/hello.ts`, `tests/hello.test.ts`

```ts
export function hello(name: string): string {
  return `Hello, ${name}!`
}
```

Pure, no I/O, no default parameter guessing — `name` is required.

**Tests:** given a name, returns `Hello, <name>!`; works for a name containing spaces or
punctuation (e.g. `"Jane Doe"`).

**Done when:** `npx vitest run tests/hello.test.ts` passes, `npm run typecheck` is clean.

---

### Subtask 2: register `contrail_hello`, document it

**Files:** `src/index.ts` (new), `tests/index.test.ts`, `package.json`, `README.md`

1. Add `@modelcontextprotocol/sdk` to `dependencies` in `package.json`.
2. `src/index.ts`: construct an `McpServer`, register a `contrail_hello` tool with input
   schema `{ name: z.string() }` (zod is already available via the SDK's peer dependency,
   or import `z` from `zod` directly — add `zod` to `dependencies` if it is not already
   resolvable), whose handler calls `hello(name)` from `src/hello.ts` and returns it as
   `{ content: [{ type: 'text', text: hello(name) }] }`. Export the server instance (and/or
   a `createServer()` factory) so it is importable from a test without starting a
   transport.
3. `tests/index.test.ts`: import the exported server/factory, invoke the `contrail_hello`
   tool handler directly (no transport needed), assert it returns `Hello, <name>!` for a
   given name.
4. README: add a `## Tools` section with a table:

   | Tool | Description |
   |---|---|
   | `contrail_hello` | Returns `Hello, <name>!` for a given `name`. |

**Done when:** `npm test` passes (including subtask 1's test), `npm run typecheck` is
clean, README renders the `Tools` table.

---

## Done when

- `npm test` passes, `npm run typecheck` is clean.
- `contrail_hello` is registered in `src/index.ts` and documented in `README.md`.

## Not in this task

- Any MCP tool other than `contrail_hello`.
- Exposing the MCP server via a CLI subcommand or `bin` entry.
