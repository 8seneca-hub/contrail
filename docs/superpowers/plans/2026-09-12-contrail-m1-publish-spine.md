# contrail M1 — Publish Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markdown documents in a git repository are published to Plane wiki pages, with Mermaid diagrams rendered to images and uploaded as page assets, idempotently and without ever destroying a human's edit.

**Architecture:** Each Markdown file is parsed once into an mdast tree. Custom transforms replace Mermaid blocks, artifact blocks and GFM alerts with Plane's component markup, then the tree is converted to HTML and passed through `rehype-sanitize` configured with Plane's exact allowed-tag list — so the sanitizer is the last step and acts as the safety net rather than a hope. Publishing is two-phase because Plane requires a page UUID before its assets can be uploaded: create a stub page, upload assets, then replace the body. A committed lockfile maps document path to page UUID and content hashes, giving idempotency and change detection.

**Tech Stack:** Node 22+, TypeScript (strict, ESM), unified/remark/rehype, `@mermaid-js/mermaid-cli`, vitest, `jiti` for config loading, `p-limit` for request concurrency, `node:util` `parseArgs` for the CLI.

**Spec:** `docs/superpowers/specs/2026-09-12-contrail-design.md`

## Global Constraints

- **Node >= 22.** Native `fetch` and `structuredClone` are used; do not add `node-fetch` or `axios`.
- **ESM only.** `package.json` has `"type": "module"`. All relative imports carry an explicit `.js` extension.
- **TypeScript strict mode.** `strict: true`, `noUncheckedIndexedAccess: true`.
- **Plane API base URL:** `{config.plane.baseUrl}/api/v1`. Every request sends header `X-API-Key: process.env.PLANE_API_KEY`.
- **The API key is read from the environment only.** It must never be read from, or written to, a config file or the lockfile.
- **Page update is `PUT`, not `PATCH`,** and it replaces the entire page body. There is no partial update.
- **`description_html` payload ceiling is 10 MB.** Check before writing; fail with a clear message naming the document.
- **Maximum 4 concurrent requests to Plane.** Self-hosted instances are not a CDN.
- **Every module is pure where it can be.** Emitters are `(doc, context) => string` with no I/O, because that is what makes them cheap to test.
- **Never invent a Plane endpoint.** The verified surface is listed in Task 10 and is the only one permitted.

### Verified Plane endpoints (the complete set M1 may use)

| Purpose | Method | Path |
|---|---|---|
| Create wiki page | POST | `/api/v1/workspaces/{ws}/pages/` |
| Retrieve wiki page | GET | `/api/v1/workspaces/{ws}/pages/{page_id}/` |
| Update wiki page | PUT | `/api/v1/workspaces/{ws}/pages/{page_id}/` |
| Archive wiki page | POST | `/api/v1/workspaces/{ws}/pages/{page_id}/archive/` |
| List wiki pages | GET | `/api/v1/workspaces/{ws}/pages/` |
| Create asset upload | POST | `/api/v1/workspaces/{ws}/assets/` |
| Confirm attachment | PATCH | `/api/v1/workspaces/{ws}/pages/{page_id}/attachments/{attachment_id}/` |

Page creation accepts `name`, `description_html`, `access`, `parent_id`, `collection_id`. `parent_id` and `collection_id` are mutually exclusive — sending both returns `400`. Creating a child page may return **`202 Accepted`**, meaning the page exists but Plane is still linking it to its parent; the response body already contains the page id and this is a success, not an error.

Asset upload is three calls: `POST /assets/` with `entity_type: "PAGE_DESCRIPTION"` and `entity_identifier: <page uuid>` returns `{ asset_id, upload_data: { url, fields } }`; the bytes go to `upload_data.url` as a multipart form containing every entry of `fields` followed by the file under the field name `file`; then the attachment is confirmed with the PATCH above and body `{"is_uploaded": true}`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | Shared types. No logic, no imports from other `src` modules. |
| `src/config.ts` | Find `contrail.config.*` by walking up from the cwd; load and validate it. |
| `src/parse.ts` | One Markdown file to a `Doc` — frontmatter validated, body parsed to mdast. |
| `src/blocks/alert.ts` | Recognise `> [!NOTE]` blockquotes and map them to Plane callout attributes. |
| `src/blocks/artifact.ts` | Parse artifact-block metadata and enforce the fallback/summary invariant. |
| `src/blocks/mermaid.ts` | Find Mermaid code nodes in a tree. |
| `src/render/mermaid.ts` | Render a Mermaid source to PNG and SVG, cached by content hash. |
| `src/emit/plane-schema.ts` | Plane's allowed tags and attributes, as a `rehype-sanitize` schema. |
| `src/emit/plane.ts` | `Doc` to Plane-safe HTML. |
| `src/emit/md.ts` | `Doc` to plain Markdown with artifact blocks flattened. |
| `src/lock.ts` | Read, write and hash the lockfile. |
| `src/plane/client.ts` | Thin typed wrapper over the seven endpoints above. Transport only, no policy. |
| `src/plane/publish.ts` | Two-phase publish, the guards, and change detection. Policy lives here. |
| `src/cli.ts` | Argument parsing and command dispatch. |

`client.ts` holds no decisions and `publish.ts` makes no HTTP calls directly beyond the client — that separation is what allows the publisher's guards to be tested without a network.

---

### Task 1: Project scaffold and config loading

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/types.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config`, `Doc`, `Frontmatter`, `DocStatus`, `LockEntry`, `Lock`, `RenderedDiagram` types; `findConfigPath(startDir: string): string`; `loadConfig(configPath: string): Config`; `class ConfigError extends Error`.

- [ ] **Step 1: Create the package manifest and TypeScript configuration**

`package.json`:

```json
{
  "name": "@8seneca/contrail",
  "version": "0.1.0",
  "type": "module",
  "bin": { "contrail": "./dist/cli.js" },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@mermaid-js/mermaid-cli": "^11.4.2",
    "gray-matter": "^4.0.3",
    "hast-util-sanitize": "^5.0.2",
    "jiti": "^2.4.2",
    "p-limit": "^6.2.0",
    "rehype-raw": "^7.0.0",
    "rehype-sanitize": "^6.0.0",
    "rehype-stringify": "^10.0.1",
    "remark-gfm": "^4.0.0",
    "remark-parse": "^11.0.0",
    "remark-rehype": "^11.1.1",
    "remark-stringify": "^11.0.0",
    "unified": "^11.0.5",
    "unist-util-visit": "^5.0.0"
  },
  "devDependencies": {
    "@types/mdast": "^4.0.4",
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
})
```

Then run `npm install`.

- [ ] **Step 2: Write the shared types**

`src/types.ts`:

```ts
import type { Root } from 'mdast'

export type DocStatus = 'draft' | 'review' | 'current' | 'stale'

export interface Frontmatter {
  title: string
  summary: string
  status: DocStatus
  repos?: string[]
  tags?: string[]
  decisions?: number[]
  watch?: string[]
  plane?: { collection?: string; parent?: string }
}

export interface Doc {
  /** Absolute path on disk. */
  absPath: string
  /** Path relative to the workspace root, POSIX separators. The lockfile key. */
  key: string
  frontmatter: Frontmatter
  tree: Root
  /** Markdown body with the frontmatter removed. */
  body: string
}

export interface Config {
  /** Directory containing the config file. All doc globs resolve against it. */
  root: string
  plane: { baseUrl: string; workspace: string; collection?: string }
  repos: Record<string, string>
  docs: string[]
  site?: { host: 'vercel' }
}

export interface RenderedDiagram {
  hash: string
  pngPath: string
  svgPath: string
}

export interface LockEntry {
  pageId: string
  /** Hash of the emitted Plane HTML we last wrote. */
  contentHash: string
  /** Hash of the page body as Plane reported it after our last write. */
  remoteHash: string
  /** Diagram content hash to Plane asset id. */
  assets: Record<string, string>
  archived?: boolean
}

export interface Lock {
  version: 1
  docs: Record<string, LockEntry>
}
```

- [ ] **Step 3: Write the failing test**

`tests/config.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, findConfigPath, loadConfig } from '../src/config.js'

function workspace(config: string): string {
  const root = mkdtempSync(join(tmpdir(), 'contrail-'))
  writeFileSync(join(root, 'contrail.config.json'), config)
  mkdirSync(join(root, 'repo-a', 'docs'), { recursive: true })
  return root
}

const VALID = JSON.stringify({
  plane: { baseUrl: 'https://plane.example.com', workspace: 'acme' },
  repos: { a: './repo-a' },
  docs: ['./docs/**/*.md'],
})

describe('findConfigPath', () => {
  it('finds the config by walking up from a nested directory', () => {
    const root = workspace(VALID)
    expect(findConfigPath(join(root, 'repo-a', 'docs'))).toBe(join(root, 'contrail.config.json'))
  })

  it('throws a message naming the directory when no config exists', () => {
    const empty = mkdtempSync(join(tmpdir(), 'contrail-empty-'))
    expect(() => findConfigPath(empty)).toThrow(/No contrail\.config/)
  })
})

describe('loadConfig', () => {
  it('returns the config with root set to the config directory', () => {
    const root = workspace(VALID)
    const cfg = loadConfig(join(root, 'contrail.config.json'))
    expect(cfg.root).toBe(root)
    expect(cfg.plane.workspace).toBe('acme')
  })

  it('rejects a config missing plane.workspace', () => {
    const root = workspace(JSON.stringify({ plane: { baseUrl: 'https://x' }, docs: ['./d/*.md'] }))
    expect(() => loadConfig(join(root, 'contrail.config.json'))).toThrow(ConfigError)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 5: Implement the config module**

`src/config.ts`:

```ts
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import type { Config } from './types.js'

const CONFIG_NAMES = ['contrail.config.ts', 'contrail.config.js', 'contrail.config.json']

export class ConfigError extends Error {}

export function findConfigPath(startDir: string): string {
  let dir = resolve(startDir)
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new ConfigError(
        `No contrail.config.{ts,js,json} found in ${startDir} or any parent directory. ` +
          'Run `contrail init` at the root of your workspace to create one.',
      )
    }
    dir = parent
  }
}

export function loadConfig(configPath: string): Config {
  const jiti = createJiti(configPath, { interopDefault: true })
  const raw = jiti(configPath) as Partial<Config>

  if (!raw.plane?.baseUrl) throw new ConfigError(`${configPath}: \`plane.baseUrl\` is required.`)
  if (!raw.plane?.workspace) throw new ConfigError(`${configPath}: \`plane.workspace\` is required.`)
  if (!Array.isArray(raw.docs) || raw.docs.length === 0) {
    throw new ConfigError(`${configPath}: \`docs\` must be a non-empty array of globs.`)
  }

  return {
    root: dirname(configPath),
    plane: {
      baseUrl: raw.plane.baseUrl.replace(/\/+$/, ''),
      workspace: raw.plane.workspace,
      collection: raw.plane.collection,
    },
    repos: raw.repos ?? {},
    docs: raw.docs,
    site: raw.site,
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: project scaffold and config loading"
```

---

### Task 2: Document parsing and frontmatter validation

**Files:**
- Create: `src/parse.ts`
- Test: `tests/parse.test.ts`

**Interfaces:**
- Consumes: `Doc`, `Frontmatter`, `DocStatus` from `src/types.ts`.
- Produces: `parseDoc(absPath: string, root: string): Doc`; `class DocError extends Error`.

- [ ] **Step 1: Write the failing test**

`tests/parse.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocError, parseDoc } from '../src/parse.js'

function docFile(contents: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'contrail-doc-'))
  const path = join(root, 'flow.md')
  writeFileSync(path, contents)
  return { root, path }
}

const VALID = `---
title: Settlement flow
summary: How settlement moves between services.
status: current
tags: [settlement]
---

# Heading

Body text.
`

describe('parseDoc', () => {
  it('parses frontmatter and body into a Doc', () => {
    const { root, path } = docFile(VALID)
    const doc = parseDoc(path, root)
    expect(doc.frontmatter.title).toBe('Settlement flow')
    expect(doc.frontmatter.status).toBe('current')
    expect(doc.key).toBe('flow.md')
    expect(doc.tree.children.length).toBeGreaterThan(0)
  })

  it('rejects a document with no title, naming the file', () => {
    const { root, path } = docFile('---\nsummary: s\nstatus: current\n---\nbody\n')
    expect(() => parseDoc(path, root)).toThrow(/flow\.md.*title/)
  })

  it('rejects a document with no summary', () => {
    const { root, path } = docFile('---\ntitle: t\nstatus: current\n---\nbody\n')
    expect(() => parseDoc(path, root)).toThrow(DocError)
  })

  it('rejects an unknown status value', () => {
    const { root, path } = docFile('---\ntitle: t\nsummary: s\nstatus: published\n---\nbody\n')
    expect(() => parseDoc(path, root)).toThrow(/status/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/parse.test.ts`
Expected: FAIL — cannot resolve `../src/parse.js`.

- [ ] **Step 3: Implement the parser**

`src/parse.ts`:

```ts
import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import matter from 'gray-matter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Doc, DocStatus, Frontmatter } from './types.js'

const STATUSES: readonly DocStatus[] = ['draft', 'review', 'current', 'stale']

export class DocError extends Error {}

export function parseDoc(absPath: string, root: string): Doc {
  const key = relative(root, absPath).split(sep).join('/')
  const { data, content } = matter(readFileSync(absPath, 'utf8'))
  const fm = data as Partial<Frontmatter>

  if (!fm.title) {
    throw new DocError(`${key}: frontmatter is missing required field \`title\`.`)
  }
  if (!fm.summary) {
    throw new DocError(
      `${key}: frontmatter is missing required field \`summary\`. ` +
        'It feeds the agent index and the Plane page excerpt.',
    )
  }
  if (!fm.status || !STATUSES.includes(fm.status)) {
    throw new DocError(`${key}: frontmatter \`status\` must be one of ${STATUSES.join(', ')}.`)
  }

  const tree = unified().use(remarkParse).use(remarkGfm).parse(content)
  return { absPath, key, frontmatter: fm as Frontmatter, tree, body: content }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/parse.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/parse.ts tests/parse.test.ts
git commit -m "feat: parse documents and validate frontmatter"
```

---

### Task 3: Plane sanitize schema

This is the safety net for every later emitter task, so it is built before them.

**Files:**
- Create: `src/emit/plane-schema.ts`
- Test: `tests/plane-schema.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const planeSchema: Schema` — a `hast-util-sanitize` schema matching Plane's accepted HTML exactly.

**Gotcha that will otherwise cost an hour:** `hast-util-sanitize` matches *hast property names*, not raw HTML attribute names. `data-type` is `dataType`, `data-checked` is `dataChecked`, `entity_identifier` is `entity_identifier` (underscored attributes on unknown elements keep their spelling). Get this wrong and the attributes are silently dropped, which looks exactly like Plane rejecting them.

- [ ] **Step 1: Write the failing test**

`tests/plane-schema.test.ts`:

```ts
import rehypeParse from 'rehype-parse'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { planeSchema } from '../src/emit/plane-schema.js'

function clean(html: string): string {
  return String(
    unified()
      .use(rehypeParse, { fragment: true })
      .use(rehypeSanitize, planeSchema)
      .use(rehypeStringify)
      .processSync(html),
  )
}

describe('planeSchema', () => {
  it('strips tags Plane does not accept', () => {
    const out = clean('<p>keep</p><script>bad()</script><style>a{}</style><svg><circle/></svg><iframe src="https://x"></iframe>')
    expect(out).toBe('<p>keep</p>')
  })

  it('keeps the documented content tags', () => {
    const html = '<h2>T</h2><table><tbody><tr><td>c</td></tr></tbody></table><pre><code>x</code></pre><blockquote><p>q</p></blockquote>'
    expect(clean(html)).toBe(html)
  })

  it('keeps task list attributes', () => {
    const html = '<ul data-type="taskList"><li data-checked="true">done</li></ul>'
    expect(clean(html)).toBe(html)
  })

  it('keeps Plane component elements and their attributes', () => {
    const html = '<image-component id="a" src="b" width="320" height="160" alignment="left" status="uploaded"></image-component>'
    expect(clean(html)).toBe(html)
  })

  it('keeps callout divs but drops unrelated divs', () => {
    expect(clean('<div data-block-type="callout-component" data-background="#eff6ff"><p>note</p></div>'))
      .toContain('data-block-type="callout-component"')
    expect(clean('<div class="wrapper"><p>x</p></div>')).toBe('<p>x</p>')
  })

  it('drops unsafe URL protocols', () => {
    expect(clean('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/plane-schema.test.ts`
Expected: FAIL — cannot resolve `../src/emit/plane-schema.js`.

- [ ] **Step 3: Implement the schema**

`src/emit/plane-schema.ts`:

```ts
import type { Schema } from 'hast-util-sanitize'

/**
 * Plane sanitizes page HTML into its editor schema. Anything outside this set is
 * silently removed on write, so we apply the same rules locally as the final step
 * of emission — a mismatch then fails a test here rather than appearing as a
 * mysteriously empty page in Plane.
 */
export const planeSchema: Schema = {
  tagNames: [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'u', 's', 'code', 'pre', 'a', 'br',
    'blockquote', 'ul', 'ol', 'li', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'div',
    'mention-component', 'issue-embed-component', 'page-embed-component',
    'image-component', 'external-embed-component', 'attachment-component',
    'inline-math-component', 'block-math-component', 'inline-date-component',
  ],
  attributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'width', 'height'],
    ol: ['start'],
    ul: ['dataType'],
    li: ['dataChecked'],
    div: ['dataBlockType', 'dataBackground', 'dataLogoInUse', 'dataEmojiUnicode'],
    'image-component': ['id', 'src', 'width', 'height', 'alignment', 'status'],
    'attachment-component': ['id', 'src', 'status', 'dataName', 'dataFileSize', 'dataFileType'],
    'mention-component': ['id', 'entity_identifier', 'entity_name'],
    'issue-embed-component': [
      'id', 'entity_identifier', 'project_identifier', 'workspace_identifier', 'entity_name',
    ],
    'page-embed-component': ['id', 'entity_identifier', 'workspace_identifier', 'entity_name'],
    'external-embed-component': [
      'id', 'src', 'dataEntityName', 'dataEntityType', 'dataIsRichCard',
      'dataHasTriedEmbedding', 'dataHasEmbedFailed',
    ],
    'inline-math-component': ['id', 'latex'],
    'block-math-component': ['id', 'latex'],
    'inline-date-component': ['id', 'date'],
  },
  protocols: {
    href: ['http', 'https', 'mailto', 'tel'],
    src: ['http', 'https'],
  },
  strip: ['script', 'style'],
  clobber: [],
  ancestors: {},
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/plane-schema.test.ts`
Expected: PASS, 6 tests. If the callout-div test fails because `div` is dropped entirely, confirm `div` appears in `tagNames` and that the attribute names are camelCased as described in the gotcha above.

- [ ] **Step 5: Commit**

```bash
git add src/emit/plane-schema.ts tests/plane-schema.test.ts
git commit -m "feat: Plane HTML sanitize schema"
```

---

### Task 4: Alert blocks

**Files:**
- Create: `src/blocks/alert.ts`
- Test: `tests/alert.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface Alert { kind: AlertKind; background: string; emojiUnicode: string; label: string }`; `matchAlert(node: Blockquote): Alert | null`; `stripAlertMarker(node: Blockquote): void`.

`remark-gfm` does not parse GitHub alert syntax, so this is a small transform over blockquotes rather than a plugin. It is about thirty lines and does not warrant a dependency.

- [ ] **Step 1: Write the failing test**

`tests/alert.test.ts`:

```ts
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import type { Blockquote } from 'mdast'
import { matchAlert, stripAlertMarker } from '../src/blocks/alert.js'

function firstBlockquote(md: string): Blockquote {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(md)
  const node = tree.children.find((c) => c.type === 'blockquote')
  if (!node) throw new Error('no blockquote in fixture')
  return node as Blockquote
}

describe('matchAlert', () => {
  it('recognises a NOTE alert', () => {
    const alert = matchAlert(firstBlockquote('> [!NOTE]\n> Body text.\n'))
    expect(alert?.kind).toBe('NOTE')
    expect(alert?.background).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('recognises a WARNING alert with a different background', () => {
    const note = matchAlert(firstBlockquote('> [!NOTE]\n> a\n'))
    const warn = matchAlert(firstBlockquote('> [!WARNING]\n> a\n'))
    expect(warn?.kind).toBe('WARNING')
    expect(warn?.background).not.toBe(note?.background)
  })

  it('returns null for an ordinary blockquote', () => {
    expect(matchAlert(firstBlockquote('> just a quote\n'))).toBeNull()
  })

  it('removes the marker line from the quote body', () => {
    const quote = firstBlockquote('> [!NOTE]\n> Body text.\n')
    stripAlertMarker(quote)
    const text = JSON.stringify(quote)
    expect(text).not.toContain('[!NOTE]')
    expect(text).toContain('Body text.')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/alert.test.ts`
Expected: FAIL — cannot resolve `../src/blocks/alert.js`.

- [ ] **Step 3: Implement the alert matcher**

`src/blocks/alert.ts`:

```ts
import type { Blockquote, Paragraph, Text } from 'mdast'

export type AlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

export interface Alert {
  kind: AlertKind
  /** Plane callout `data-background`. */
  background: string
  /** Plane callout `data-emoji-unicode`: a decimal codepoint, as Plane expects. */
  emojiUnicode: string
  label: string
}

const ALERTS: Record<AlertKind, Omit<Alert, 'kind'>> = {
  NOTE: { background: '#eff6ff', emojiUnicode: '128161', label: 'Note' },
  TIP: { background: '#ecfdf5', emojiUnicode: '128161', label: 'Tip' },
  IMPORTANT: { background: '#eef2ff', emojiUnicode: '10071', label: 'Important' },
  WARNING: { background: '#fffbeb', emojiUnicode: '9888', label: 'Warning' },
  CAUTION: { background: '#fef2f2', emojiUnicode: '9940', label: 'Caution' },
}

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/

function firstText(node: Blockquote): Text | null {
  const paragraph = node.children[0]
  if (!paragraph || paragraph.type !== 'paragraph') return null
  const text = (paragraph as Paragraph).children[0]
  return text && text.type === 'text' ? (text as Text) : null
}

export function matchAlert(node: Blockquote): Alert | null {
  const text = firstText(node)
  const match = text?.value.match(MARKER)
  if (!match) return null
  const kind = match[1] as AlertKind
  return { kind, ...ALERTS[kind] }
}

/** Removes the `[!KIND]` marker, and the now-empty first line, from the quote. */
export function stripAlertMarker(node: Blockquote): void {
  const text = firstText(node)
  if (!text) return
  text.value = text.value.replace(MARKER, '').replace(/^\n+/, '')
  const paragraph = node.children[0] as Paragraph
  if (text.value === '' && paragraph.children.length === 1) {
    node.children.shift()
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/alert.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/blocks/alert.ts tests/alert.test.ts
git commit -m "feat: recognise GitHub alert blockquotes as Plane callouts"
```

---

### Task 5: Artifact blocks and the fallback invariant

**Files:**
- Create: `src/blocks/artifact.ts`
- Test: `tests/artifact.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface ArtifactMeta { fallback: string; summary: string }`; `parseArtifactMeta(meta: string | null | undefined, where: string): ArtifactMeta`; `class ArtifactBlockError extends Error`.

This task implements the invariant the whole design rests on: an artifact block may be arbitrarily rich in the HTML output, but it must always declare a static `fallback` image and a prose `summary`, so Plane readers and coding agents never lose information a human gained. A block missing either one fails the build.

- [ ] **Step 1: Write the failing test**

`tests/artifact.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ArtifactBlockError, parseArtifactMeta } from '../src/blocks/artifact.js'

describe('parseArtifactMeta', () => {
  it('parses fallback and summary', () => {
    const meta = parseArtifactMeta('{fallback="./img/flow.png", summary="Settlement flow"}', 'flow.md:12')
    expect(meta).toEqual({ fallback: './img/flow.png', summary: 'Settlement flow' })
  })

  it('accepts single quotes and no braces', () => {
    const meta = parseArtifactMeta("fallback='a.png' summary='S'", 'flow.md:1')
    expect(meta.fallback).toBe('a.png')
  })

  it('rejects a block with no fallback, explaining why', () => {
    expect(() => parseArtifactMeta('{summary="S"}', 'flow.md:12')).toThrow(/flow\.md:12.*fallback/s)
  })

  it('rejects a block with no summary', () => {
    expect(() => parseArtifactMeta('{fallback="a.png"}', 'flow.md:12')).toThrow(ArtifactBlockError)
  })

  it('rejects an empty meta string', () => {
    expect(() => parseArtifactMeta(null, 'flow.md:12')).toThrow(ArtifactBlockError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/artifact.test.ts`
Expected: FAIL — cannot resolve `../src/blocks/artifact.js`.

- [ ] **Step 3: Implement the meta parser**

`src/blocks/artifact.ts`:

```ts
export interface ArtifactMeta {
  /** Path to a static image, relative to the document. */
  fallback: string
  /** Prose describing what the interactive block shows. */
  summary: string
}

export class ArtifactBlockError extends Error {}

const ATTR = /(\w+)\s*=\s*("([^"]*)"|'([^']*)')/g

function parseAttrs(meta: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of meta.matchAll(ATTR)) {
    out[match[1]!] = match[3] ?? match[4] ?? ''
  }
  return out
}

export function parseArtifactMeta(meta: string | null | undefined, where: string): ArtifactMeta {
  const attrs = parseAttrs(meta ?? '')
  if (!attrs.fallback) {
    throw new ArtifactBlockError(
      `${where}: artifact block is missing \`fallback\`. Every artifact block must declare a ` +
        'static image, so readers in Plane see the same information as readers of the site.',
    )
  }
  if (!attrs.summary) {
    throw new ArtifactBlockError(
      `${where}: artifact block is missing \`summary\`. Without it, an agent reading the ` +
        'Markdown has no idea what this block contains.',
    )
  }
  return { fallback: attrs.fallback, summary: attrs.summary }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/artifact.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/blocks/artifact.ts tests/artifact.test.ts
git commit -m "feat: artifact block metadata with mandatory fallback and summary"
```

---

### Task 6: Mermaid rendering, caching, and asset collection

**Files:**
- Create: `src/render/mermaid.ts`, `src/assets.ts`
- Test: `tests/mermaid.test.ts`, `tests/assets.test.ts`

**Interfaces:**
- Consumes: `Doc`, `RenderedDiagram` from `src/types.ts`; `parseArtifactMeta` from Task 5.
- Produces:
  - `diagramHash(source: string): string` — first 16 hex characters of the SHA-256 of the diagram source.
  - `type Mmdc = (inputFile: string, outputFile: string) => Promise<void>`
  - `renderMermaid(source: string, cacheDir: string, mmdc?: Mmdc): Promise<RenderedDiagram>`
  - `interface AssetPlan { id: string; hash: string; filePath: string; contentType: string }`
  - `assetIdForDiagram(source: string): string` returning `mermaid:<hash>`
  - `assetIdForFile(fallbackPath: string): string` returning `file:<path>`
  - `collectAssets(doc: Doc, opts: { cacheDir: string; mmdc?: Mmdc }): Promise<AssetPlan[]>`

Rendering drives a headless browser and is by far the slowest step, so results are cached by the hash of the diagram source. The `mmdc` parameter exists so that unit tests never launch a browser.

Asset ids are computed from the node alone — a diagram from its source text, a fallback from its declared path — which is what allows the emitter in Task 8 to stay a pure function with no file access.

- [ ] **Step 1: Write the failing test for rendering**

`tests/mermaid.test.ts`:

```ts
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { diagramHash, renderMermaid } from '../src/render/mermaid.js'

const SOURCE = 'graph TD;\n  A-->B;\n'

function fakeMmdc() {
  return vi.fn(async (_input: string, output: string) => {
    writeFileSync(output, 'stub')
  })
}

describe('renderMermaid', () => {
  it('renders png and svg and reports the hash', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const mmdc = fakeMmdc()
    const result = await renderMermaid(SOURCE, cache, mmdc)
    expect(result.hash).toBe(diagramHash(SOURCE))
    expect(existsSync(result.pngPath)).toBe(true)
    expect(existsSync(result.svgPath)).toBe(true)
    expect(mmdc).toHaveBeenCalledTimes(2)
  })

  it('does not re-render when the cache already holds both outputs', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const mmdc = fakeMmdc()
    await renderMermaid(SOURCE, cache, mmdc)
    mmdc.mockClear()
    await renderMermaid(SOURCE, cache, mmdc)
    expect(mmdc).not.toHaveBeenCalled()
  })

  it('gives different hashes to different diagrams', () => {
    expect(diagramHash('graph TD; A-->B;')).not.toBe(diagramHash('graph TD; A-->C;'))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mermaid.test.ts`
Expected: FAIL — cannot resolve `../src/render/mermaid.js`.

- [ ] **Step 3: Implement rendering with cache**

`src/render/mermaid.ts`:

```ts
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RenderedDiagram } from '../types.js'

export type Mmdc = (inputFile: string, outputFile: string) => Promise<void>

export function diagramHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

const spawnMmdc: Mmdc = (inputFile, outputFile) =>
  new Promise((resolve, reject) => {
    const child = spawn('npx', ['mmdc', '-i', inputFile, '-o', outputFile, '-b', 'transparent'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`mmdc exited with code ${code}: ${stderr.trim()}`))
    })
  })

export async function renderMermaid(
  source: string,
  cacheDir: string,
  mmdc: Mmdc = spawnMmdc,
): Promise<RenderedDiagram> {
  const hash = diagramHash(source)
  const dir = join(cacheDir, 'mermaid')
  mkdirSync(dir, { recursive: true })

  const pngPath = join(dir, `${hash}.png`)
  const svgPath = join(dir, `${hash}.svg`)
  if (existsSync(pngPath) && existsSync(svgPath)) return { hash, pngPath, svgPath }

  const inputFile = join(dir, `${hash}.mmd`)
  writeFileSync(inputFile, source)
  if (!existsSync(pngPath)) await mmdc(inputFile, pngPath)
  if (!existsSync(svgPath)) await mmdc(inputFile, svgPath)
  return { hash, pngPath, svgPath }
}
```

- [ ] **Step 4: Run the rendering test to verify it passes**

Run: `npx vitest run tests/mermaid.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing test for asset collection**

`tests/assets.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { collectAssets, assetIdForDiagram, assetIdForFile } from '../src/assets.js'
import { parseDoc } from '../src/parse.js'

const DOC = `---
title: T
summary: S
status: current
---

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`artifact {fallback="./flow.png", summary="An explorer"}
<div id="explorer"></div>
\`\`\`
`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'contrail-assets-'))
  writeFileSync(join(root, 'doc.md'), DOC)
  writeFileSync(join(root, 'flow.png'), 'png-bytes')
  return root
}

describe('collectAssets', () => {
  it('collects one asset per diagram and per artifact fallback', async () => {
    const root = fixture()
    const doc = parseDoc(join(root, 'doc.md'), root)
    const mmdc = vi.fn(async (_i: string, o: string) => writeFileSync(o, 'stub'))
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })

    expect(assets).toHaveLength(2)
    expect(assets.map((a) => a.id)).toEqual([
      assetIdForDiagram('graph TD; A-->B;\n'),
      assetIdForFile('./flow.png'),
    ])
    expect(assets[1]!.contentType).toBe('image/png')
  })

  it('fails when an artifact fallback file does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-missing-'))
    writeFileSync(join(root, 'doc.md'), DOC)
    const doc = parseDoc(join(root, 'doc.md'), root)
    const mmdc = vi.fn(async (_i: string, o: string) => writeFileSync(o, 'stub'))
    await expect(collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })).rejects.toThrow(/flow\.png/)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/assets.test.ts`
Expected: FAIL — cannot resolve `../src/assets.js`.

- [ ] **Step 7: Implement asset collection**

`src/assets.ts`:

```ts
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { visit } from 'unist-util-visit'
import type { Code } from 'mdast'
import { parseArtifactMeta } from './blocks/artifact.js'
import { diagramHash, renderMermaid, type Mmdc } from './render/mermaid.js'
import type { Doc } from './types.js'

export interface AssetPlan {
  /** Stable identity computed from the document alone. */
  id: string
  /** Content hash, used for change detection. */
  hash: string
  filePath: string
  contentType: string
}

export function assetIdForDiagram(source: string): string {
  return `mermaid:${diagramHash(source)}`
}

export function assetIdForFile(fallbackPath: string): string {
  return `file:${fallbackPath}`
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export async function collectAssets(
  doc: Doc,
  opts: { cacheDir: string; mmdc?: Mmdc },
): Promise<AssetPlan[]> {
  const codes: Code[] = []
  visit(doc.tree, 'code', (node: Code) => {
    if (node.lang === 'mermaid' || node.lang === 'artifact') codes.push(node)
  })

  const plans: AssetPlan[] = []
  for (const node of codes) {
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`

    if (node.lang === 'mermaid') {
      const rendered = await renderMermaid(node.value, opts.cacheDir, opts.mmdc)
      plans.push({
        id: assetIdForDiagram(node.value),
        hash: rendered.hash,
        filePath: rendered.pngPath,
        contentType: 'image/png',
      })
      continue
    }

    const meta = parseArtifactMeta(node.meta, where)
    const filePath = resolve(dirname(doc.absPath), meta.fallback)
    if (!existsSync(filePath)) {
      throw new Error(`${where}: artifact fallback image not found: ${meta.fallback}`)
    }
    const bytes = readFileSync(filePath)
    plans.push({
      id: assetIdForFile(meta.fallback),
      hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      filePath,
      contentType: CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    })
  }
  return plans
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `npx vitest run tests/mermaid.test.ts tests/assets.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Commit**

```bash
git add src/render/mermaid.ts src/assets.ts tests/mermaid.test.ts tests/assets.test.ts
git commit -m "feat: cached mermaid rendering and document asset collection"
```

---

### Task 7: Markdown emitter

**Files:**
- Create: `src/emit/md.ts`
- Test: `tests/emit-md.test.ts`

**Interfaces:**
- Consumes: `Doc` from `src/types.ts`; `parseArtifactMeta` from Task 5.
- Produces: `emitMarkdown(doc: Doc): string`.

Mermaid fences are deliberately left untouched: an agent reads a diagram's source more usefully than it reads a picture of one. Only artifact blocks are flattened, into their fallback image and summary — which is the whole reason those two fields are mandatory.

- [ ] **Step 1: Write the failing test**

`tests/emit-md.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitMarkdown } from '../src/emit/md.js'
import { parseDoc } from '../src/parse.js'

const DOC = `---
title: T
summary: S
status: current
---

Intro.

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`artifact {fallback="./flow.png", summary="An interactive settlement explorer."}
<div id="explorer"></div>
\`\`\`
`

function doc() {
  const root = mkdtempSync(join(tmpdir(), 'contrail-md-'))
  writeFileSync(join(root, 'doc.md'), DOC)
  return parseDoc(join(root, 'doc.md'), root)
}

describe('emitMarkdown', () => {
  it('keeps mermaid fences intact for agents', () => {
    expect(emitMarkdown(doc())).toContain('```mermaid')
  })

  it('replaces artifact blocks with the fallback image and summary', () => {
    const out = emitMarkdown(doc())
    expect(out).toContain('![An interactive settlement explorer.](./flow.png)')
    expect(out).toContain('An interactive settlement explorer.')
    expect(out).not.toContain('<div id="explorer">')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/emit-md.test.ts`
Expected: FAIL — cannot resolve `../src/emit/md.js`.

- [ ] **Step 3: Implement the Markdown emitter**

`src/emit/md.ts`:

```ts
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Code, Parent, Root, RootContent } from 'mdast'
import { parseArtifactMeta } from '../blocks/artifact.js'
import type { Doc } from '../types.js'

export function emitMarkdown(doc: Doc): string {
  const tree = structuredClone(doc.tree) as Root

  visit(tree, 'code', (node: Code, index: number | undefined, parent: Parent | undefined) => {
    if (node.lang !== 'artifact' || parent === undefined || index === undefined) return
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`
    const meta = parseArtifactMeta(node.meta, where)
    const replacement: RootContent[] = [
      {
        type: 'paragraph',
        children: [{ type: 'image', url: meta.fallback, alt: meta.summary }],
      },
      { type: 'paragraph', children: [{ type: 'text', value: meta.summary }] },
    ]
    parent.children.splice(index, 1, ...replacement)
  })

  return String(unified().use(remarkGfm).use(remarkStringify, { fences: true }).stringify(tree))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/emit-md.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/emit/md.ts tests/emit-md.test.ts
git commit -m "feat: markdown emitter flattening artifact blocks"
```

---

### Task 8: Plane HTML emitter

**Files:**
- Create: `src/emit/plane.ts`
- Test: `tests/emit-plane.test.ts`

**Interfaces:**
- Consumes: `Doc` from `src/types.ts`; `matchAlert`/`stripAlertMarker` from Task 4; `parseArtifactMeta` from Task 5; `assetIdForDiagram`/`assetIdForFile` from Task 6; `planeSchema` from Task 3.
- Produces:
  - `interface PlaneEmitContext { assetIds: Record<string, string>; updated: string; siteUrl?: string }`
  - `emitPlane(doc: Doc, ctx: PlaneEmitContext): string`

`assetIds` maps the asset ids from Task 6 to the Plane asset UUIDs returned by upload. The emitter performs no I/O, which is what keeps it testable with a plain object.

The page title is **not** emitted as a heading — Plane stores it as the page `name`, and duplicating it produces a document with its title written twice.

**One thing to verify against a live instance:** Plane's documentation shows `<image-component src="https://...">` for external images and `<attachment-component src="ASSET_ID">` for uploaded assets. This plan assumes an uploaded image is referenced by its asset id. It is isolated in the single constant `imageSrc()` below, so if a live page renders a broken image, that function is the only thing to change. Task 11's integration test is where this gets confirmed.

- [ ] **Step 1: Write the failing test**

`tests/emit-plane.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import rehypeParse from 'rehype-parse'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { assetIdForDiagram, assetIdForFile } from '../src/assets.js'
import { emitPlane } from '../src/emit/plane.js'
import { planeSchema } from '../src/emit/plane-schema.js'
import { parseDoc } from '../src/parse.js'

const BODY = `Intro text.

> [!WARNING]
> Mind the gap.

| Owner | Status |
| --- | --- |
| Design | Done |

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`artifact {fallback="./flow.png", summary="An interactive settlement explorer."}
<div id="explorer"></div>
\`\`\`
`

function doc(status = 'current') {
  const root = mkdtempSync(join(tmpdir(), 'contrail-plane-'))
  writeFileSync(join(root, 'doc.md'), `---\ntitle: T\nsummary: S\nstatus: ${status}\n---\n\n${BODY}`)
  return parseDoc(join(root, 'doc.md'), root)
}

const ctx = {
  assetIds: {
    [assetIdForDiagram('graph TD; A-->B;\n')]: 'asset-diagram-uuid',
    [assetIdForFile('./flow.png')]: 'asset-fallback-uuid',
  },
  updated: '2026-09-12',
  siteUrl: 'https://docs.example.com/doc',
}

describe('emitPlane', () => {
  it('renders a diagram as an image component referencing its uploaded asset', () => {
    expect(emitPlane(doc(), ctx)).toContain('<image-component')
    expect(emitPlane(doc(), ctx)).toContain('asset-diagram-uuid')
  })

  it('renders an artifact block as its fallback image plus the summary', () => {
    const html = emitPlane(doc(), ctx)
    expect(html).toContain('asset-fallback-uuid')
    expect(html).toContain('An interactive settlement explorer.')
    expect(html).not.toContain('id="explorer"')
  })

  it('renders an alert as a Plane callout', () => {
    const html = emitPlane(doc(), ctx)
    expect(html).toContain('data-block-type="callout-component"')
    expect(html).toContain('Mind the gap.')
    expect(html).not.toContain('[!WARNING]')
  })

  it('keeps GFM tables', () => {
    expect(emitPlane(doc(), ctx)).toContain('<table>')
  })

  it('does not repeat the title as a heading', () => {
    expect(emitPlane(doc(), ctx)).not.toContain('<h1>T</h1>')
  })

  it('adds a link to the interactive version when a site URL is given', () => {
    expect(emitPlane(doc(), ctx)).toContain('https://docs.example.com/doc')
  })

  it('warns at the top of the page when the document is stale', () => {
    const html = emitPlane(doc('stale'), ctx)
    const firstCallout = html.indexOf('callout-component')
    expect(firstCallout).toBeGreaterThanOrEqual(0)
    expect(html.slice(0, firstCallout + 400)).toMatch(/stale/i)
  })

  it('emits only HTML that survives Plane sanitization unchanged', () => {
    const html = emitPlane(doc(), ctx)
    const sanitized = String(
      unified()
        .use(rehypeParse, { fragment: true })
        .use(rehypeSanitize, planeSchema)
        .use(rehypeStringify)
        .processSync(html),
    )
    expect(sanitized).toBe(html)
  })
})
```

The final test is the important one. It asserts that what contrail sends is exactly what Plane will keep — so if a future change emits something Plane would silently strip, a test fails here instead of a page quietly losing content in production.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/emit-plane.test.ts`
Expected: FAIL — cannot resolve `../src/emit/plane.js`.

- [ ] **Step 3: Implement the Plane emitter**

`src/emit/plane.ts`:

```ts
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Blockquote, Code, Html, Parent, Root, RootContent } from 'mdast'
import { assetIdForDiagram, assetIdForFile } from '../assets.js'
import { matchAlert, stripAlertMarker } from '../blocks/alert.js'
import { parseArtifactMeta } from '../blocks/artifact.js'
import type { Doc } from '../types.js'
import { planeSchema } from './plane-schema.js'

export interface PlaneEmitContext {
  /** Asset id from `src/assets.ts` to the Plane asset UUID returned by upload. */
  assetIds: Record<string, string>
  /** ISO date shown in the page footer. */
  updated: string
  /** Link to the interactive version, when one has been published. */
  siteUrl?: string
}

const html = (value: string): Html => ({ type: 'html', value })

/** Plane references an uploaded page asset by its asset id. See the note in the plan. */
function imageSrc(assetUuid: string): string {
  return assetUuid
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function imageComponent(assetUuid: string, id: string): Html {
  return html(
    `<image-component id="${escapeHtml(id)}" src="${escapeHtml(imageSrc(assetUuid))}" ` +
      'alignment="center" status="uploaded"></image-component>',
  )
}

function callout(background: string, emojiUnicode: string, inner: RootContent[]): RootContent[] {
  return [
    html(
      `<div data-block-type="callout-component" data-background="${background}" ` +
        `data-logo-in-use="emoji" data-emoji-unicode="${emojiUnicode}">`,
    ),
    ...inner,
    html('</div>'),
  ]
}

function text(value: string): RootContent {
  return { type: 'paragraph', children: [{ type: 'text', value }] }
}

function transformAlerts(tree: Root): void {
  visit(tree, 'blockquote', (node: Blockquote, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return
    const alert = matchAlert(node)
    if (!alert) return
    stripAlertMarker(node)
    parent.children.splice(index, 1, ...callout(alert.background, alert.emojiUnicode, node.children as RootContent[]))
  })
}

function transformCodeBlocks(doc: Doc, tree: Root, ctx: PlaneEmitContext): void {
  visit(tree, 'code', (node: Code, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return

    if (node.lang === 'mermaid') {
      const id = assetIdForDiagram(node.value)
      const uuid = ctx.assetIds[id]
      if (!uuid) throw new Error(`${doc.key}: no uploaded asset for diagram ${id}`)
      parent.children.splice(index, 1, imageComponent(uuid, id))
      return
    }

    if (node.lang === 'artifact') {
      const where = `${doc.key}:${node.position?.start.line ?? '?'}`
      const meta = parseArtifactMeta(node.meta, where)
      const id = assetIdForFile(meta.fallback)
      const uuid = ctx.assetIds[id]
      if (!uuid) throw new Error(`${where}: no uploaded asset for fallback ${meta.fallback}`)
      parent.children.splice(index, 1, imageComponent(uuid, id), text(meta.summary))
    }
  })
}

const STATUS_NOTICE: Record<string, { background: string; emoji: string; message: string }> = {
  draft: { background: '#fffbeb', emoji: '9888', message: 'Draft — this document is still being written.' },
  review: { background: '#eff6ff', emoji: '128161', message: 'In review — content may still change.' },
  stale: {
    background: '#fef2f2',
    emoji: '9940',
    message: 'Stale — this document is known to be out of date. Do not rely on it.',
  },
}

export function emitPlane(doc: Doc, ctx: PlaneEmitContext): string {
  const tree = structuredClone(doc.tree) as Root

  transformAlerts(tree)
  transformCodeBlocks(doc, tree, ctx)

  const notice = STATUS_NOTICE[doc.frontmatter.status]
  if (notice) {
    tree.children.unshift(...callout(notice.background, notice.emoji, [text(notice.message)]))
  }

  if (ctx.siteUrl) {
    tree.children.unshift(
      ...callout('#eff6ff', '128279', [
        {
          type: 'paragraph',
          children: [{ type: 'link', url: ctx.siteUrl, children: [{ type: 'text', value: 'Interactive version' }] }],
        },
      ]),
    )
  }

  tree.children.push(
    html('<hr />'),
    text(`Source: ${doc.key} · updated ${ctx.updated} · status: ${doc.frontmatter.status}`),
    text('Generated by contrail. Edit the Markdown source, not this page.'),
  )

  const processor = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, planeSchema)
    .use(rehypeStringify)

  return processor.stringify(processor.runSync(tree))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/emit-plane.test.ts`
Expected: PASS, 8 tests. If the sanitization-conformance test fails, the emitter is producing markup Plane would strip — fix the emitter, not the schema, unless the Plane documentation says otherwise.

- [ ] **Step 5: Commit**

```bash
git add src/emit/plane.ts tests/emit-plane.test.ts
git commit -m "feat: Plane HTML emitter with sanitization conformance test"
```

---

### Task 9: Lockfile

**Files:**
- Create: `src/lock.ts`
- Test: `tests/lock.test.ts`

**Interfaces:**
- Consumes: `Lock`, `LockEntry` from `src/types.ts`.
- Produces: `hashContent(parts: string[]): string`; `loadLock(root: string): Lock`; `saveLock(root: string, lock: Lock): void`; `const LOCK_FILENAME = 'contrail.lock.json'`.

The lockfile is committed to git. It holds no secrets — only page ids and hashes.

- [ ] **Step 1: Write the failing test**

`tests/lock.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashContent, LOCK_FILENAME, loadLock, saveLock } from '../src/lock.js'

describe('lock', () => {
  it('returns an empty lock when the file does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    expect(loadLock(root)).toEqual({ version: 1, docs: {} })
  })

  it('round-trips entries through disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    const lock = {
      version: 1 as const,
      docs: { 'a.md': { pageId: 'p1', contentHash: 'c', remoteHash: 'r', assets: { 'mermaid:x': 'u' } } },
    }
    saveLock(root, lock)
    expect(existsSync(join(root, LOCK_FILENAME))).toBe(true)
    expect(loadLock(root)).toEqual(lock)
  })

  it('writes stable, human-readable JSON with sorted keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    saveLock(root, {
      version: 1,
      docs: {
        'b.md': { pageId: 'p2', contentHash: 'c', remoteHash: 'r', assets: {} },
        'a.md': { pageId: 'p1', contentHash: 'c', remoteHash: 'r', assets: {} },
      },
    })
    const text = readFileSync(join(root, LOCK_FILENAME), 'utf8')
    expect(text.indexOf('a.md')).toBeLessThan(text.indexOf('b.md'))
    expect(text.endsWith('\n')).toBe(true)
  })

  it('hashes content deterministically and distinguishes different content', () => {
    expect(hashContent(['a', 'b'])).toBe(hashContent(['a', 'b']))
    expect(hashContent(['a', 'b'])).not.toBe(hashContent(['a', 'c']))
  })
})
```

Sorted keys matter: an unsorted lockfile produces a noisy diff on every publish and makes merge conflicts harder than they need to be.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lock.test.ts`
Expected: FAIL — cannot resolve `../src/lock.js`.

- [ ] **Step 3: Implement the lockfile module**

`src/lock.ts`:

```ts
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Lock, LockEntry } from './types.js'

export const LOCK_FILENAME = 'contrail.lock.json'

export function hashContent(parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\n--\n')
  return hash.digest('hex').slice(0, 32)
}

export function loadLock(root: string): Lock {
  const path = join(root, LOCK_FILENAME)
  if (!existsSync(path)) return { version: 1, docs: {} }
  return JSON.parse(readFileSync(path, 'utf8')) as Lock
}

export function saveLock(root: string, lock: Lock): void {
  const docs: Record<string, LockEntry> = {}
  for (const key of Object.keys(lock.docs).sort()) docs[key] = lock.docs[key]!
  writeFileSync(join(root, LOCK_FILENAME), `${JSON.stringify({ version: 1, docs }, null, 2)}\n`)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lock.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts tests/lock.test.ts
git commit -m "feat: committed lockfile with stable ordering"
```

---

### Task 10: Plane REST client

**Files:**
- Create: `src/plane/client.ts`
- Test: `tests/plane-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
export interface CreatePageInput { name: string; description_html: string; parent_id?: string; collection_id?: string; access?: 0 | 1 }
export interface CreatePageResult { id: string; parentLinkPending: boolean }
export interface PageRecord { id: string; name: string; description_html: string; updated_at: string }
export interface AssetUpload { asset_id: string; upload_data: { url: string; fields: Record<string, string> } }
export interface PlaneApi {
  createPage(input: CreatePageInput): Promise<CreatePageResult>
  getPage(pageId: string): Promise<PageRecord>
  updatePage(pageId: string, input: { name: string; description_html: string }): Promise<void>
  archivePage(pageId: string): Promise<void>
  createAssetUpload(input: { name: string; type: string; size: number; entity_identifier: string }): Promise<AssetUpload>
  uploadAssetBytes(upload: AssetUpload, bytes: Uint8Array, contentType: string, filename: string): Promise<void>
  confirmAttachment(pageId: string, assetId: string): Promise<void>
}
export class PlaneClient implements PlaneApi { constructor(opts: { baseUrl: string; workspace: string; apiKey: string; fetchFn?: typeof fetch }) }
export class PlaneApiError extends Error { readonly status: number; readonly body: string }
```

This module is transport only. Every decision — what to publish, whether to overwrite — belongs in Task 11, which is what makes those decisions testable without a network.

- [ ] **Step 1: Write the failing test**

`tests/plane-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { PlaneApiError, PlaneClient } from '../src/plane/client.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchFn: typeof fetch) {
  return new PlaneClient({ baseUrl: 'https://plane.test', workspace: 'acme', apiKey: 'k', fetchFn })
}

function callsOf(fetchFn: typeof fetch) {
  return (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
}

describe('PlaneClient', () => {
  it('creates a page and sends the API key', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'page-1' }, 201)) as unknown as typeof fetch
    const result = await client(fetchFn).createPage({ name: 'T', description_html: '<p>x</p>' })

    expect(result).toEqual({ id: 'page-1', parentLinkPending: false })
    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as { headers: Record<string, string> }).headers['X-API-Key']).toBe('k')
  })

  it('treats 202 as success with the parent link still pending', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'page-2' }, 202)) as unknown as typeof fetch
    const result = await client(fetchFn).createPage({ name: 'T', description_html: '<p>x</p>', parent_id: 'p' })
    expect(result).toEqual({ id: 'page-2', parentLinkPending: true })
  })

  it('rejects a page created with both parent_id and collection_id', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'x' }, 201)) as unknown as typeof fetch
    await expect(
      client(fetchFn).createPage({ name: 'T', description_html: '<p>x</p>', parent_id: 'a', collection_id: 'b' }),
    ).rejects.toThrow(/both/)
  })

  it('updates a page with PUT', async () => {
    const fetchFn = vi.fn(async () => json({}, 200)) as unknown as typeof fetch
    await client(fetchFn).updatePage('page-1', { name: 'T', description_html: '<p>y</p>' })
    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/page-1/')
    expect((init as RequestInit).method).toBe('PUT')
  })

  it('throws PlaneApiError carrying the status', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    await expect(client(fetchFn).getPage('page-1')).rejects.toBeInstanceOf(PlaneApiError)
    await expect(client(fetchFn).getPage('page-1')).rejects.toMatchObject({ status: 403 })
  })

  it('posts asset bytes to the presigned URL with every field and no API key', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 204 })) as unknown as typeof fetch
    const upload = { asset_id: 'a1', upload_data: { url: 'https://s3.test/bucket', fields: { key: 'k1', policy: 'p' } } }
    await client(fetchFn).uploadAssetBytes(upload, new Uint8Array([1, 2, 3]), 'image/png', 'flow.png')

    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://s3.test/bucket')
    const form = (init as RequestInit).body as FormData
    expect(form.get('key')).toBe('k1')
    expect(form.get('policy')).toBe('p')
    expect(form.get('file')).toBeInstanceOf(Blob)
    expect((init as RequestInit).headers).toBeUndefined()
  })

  it('confirms an attachment with PATCH and is_uploaded', async () => {
    const fetchFn = vi.fn(async () => json({}, 200)) as unknown as typeof fetch
    await client(fetchFn).confirmAttachment('page-1', 'asset-1')
    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/page-1/attachments/asset-1/')
    expect((init as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ is_uploaded: true })
  })
})
```

The sixth test matters for a security reason as much as a correctness one: the presigned upload goes to object storage, a different trust boundary, and the Plane API key must never be attached to it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/plane-client.test.ts`
Expected: FAIL — cannot resolve `../src/plane/client.js`.

- [ ] **Step 3: Implement the client**

`src/plane/client.ts`:

```ts
export interface CreatePageInput {
  name: string
  description_html: string
  parent_id?: string
  collection_id?: string
  access?: 0 | 1
}

export interface CreatePageResult {
  id: string
  /** True when Plane returned 202: the page exists, the parent link is still being made. */
  parentLinkPending: boolean
}

export interface PageRecord {
  id: string
  name: string
  description_html: string
  updated_at: string
}

export interface AssetUpload {
  asset_id: string
  upload_data: { url: string; fields: Record<string, string> }
}

export interface PlaneApi {
  createPage(input: CreatePageInput): Promise<CreatePageResult>
  getPage(pageId: string): Promise<PageRecord>
  updatePage(pageId: string, input: { name: string; description_html: string }): Promise<void>
  archivePage(pageId: string): Promise<void>
  createAssetUpload(input: {
    name: string
    type: string
    size: number
    entity_identifier: string
  }): Promise<AssetUpload>
  uploadAssetBytes(upload: AssetUpload, bytes: Uint8Array, contentType: string, filename: string): Promise<void>
  confirmAttachment(pageId: string, assetId: string): Promise<void>
}

export class PlaneApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'PlaneApiError'
  }
}

export class PlaneClient implements PlaneApi {
  private readonly baseUrl: string
  private readonly workspace: string
  private readonly apiKey: string
  private readonly fetchFn: typeof fetch

  constructor(opts: { baseUrl: string; workspace: string; apiKey: string; fetchFn?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.workspace = opts.workspace
    this.apiKey = opts.apiKey
    this.fetchFn = opts.fetchFn ?? fetch
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1/workspaces/${this.workspace}${path}`
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { 'X-API-Key': this.apiKey }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const response = await this.fetchFn(this.url(path), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new PlaneApiError(`Plane ${method} ${path} failed with ${response.status}`, response.status, text)
    }
    return { status: response.status, data: text ? JSON.parse(text) : {} }
  }

  async createPage(input: CreatePageInput): Promise<CreatePageResult> {
    if (input.parent_id && input.collection_id) {
      throw new Error('Plane rejects a page created with both parent_id and collection_id.')
    }
    const { status, data } = await this.request('POST', '/pages/', input)
    return { id: (data as { id: string }).id, parentLinkPending: status === 202 }
  }

  async getPage(pageId: string): Promise<PageRecord> {
    const { data } = await this.request('GET', `/pages/${pageId}/`)
    return data as PageRecord
  }

  async updatePage(pageId: string, input: { name: string; description_html: string }): Promise<void> {
    await this.request('PUT', `/pages/${pageId}/`, input)
  }

  async archivePage(pageId: string): Promise<void> {
    await this.request('POST', `/pages/${pageId}/archive/`)
  }

  async createAssetUpload(input: {
    name: string
    type: string
    size: number
    entity_identifier: string
  }): Promise<AssetUpload> {
    const { data } = await this.request('POST', '/assets/', { ...input, entity_type: 'PAGE_DESCRIPTION' })
    return data as AssetUpload
  }

  async uploadAssetBytes(
    upload: AssetUpload,
    bytes: Uint8Array,
    contentType: string,
    filename: string,
  ): Promise<void> {
    const form = new FormData()
    for (const [key, value] of Object.entries(upload.upload_data.fields)) form.append(key, value)
    form.append('file', new Blob([bytes], { type: contentType }), filename)

    // Deliberately no API key: this is object storage, a different trust boundary.
    const response = await this.fetchFn(upload.upload_data.url, { method: 'POST', body: form })
    if (!response.ok) {
      throw new PlaneApiError(`Asset upload failed with ${response.status}`, response.status, await response.text())
    }
  }

  async confirmAttachment(pageId: string, assetId: string): Promise<void> {
    await this.request('PATCH', `/pages/${pageId}/attachments/${assetId}/`, { is_uploaded: true })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/plane-client.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/plane/client.ts tests/plane-client.test.ts
git commit -m "feat: Plane REST client for pages and assets"
```

---

### Task 11: Publisher, two-phase with guards

This is where the design's safety rules live.

**Files:**
- Create: `src/plane/publish.ts`
- Test: `tests/publish.test.ts`

**Interfaces:**
- Consumes: `PlaneApi` from Task 10; `collectAssets`/`AssetPlan` from Task 6; `emitPlane` from Task 8; `hashContent` from Task 9; `Config`, `Doc`, `Lock` from `src/types.ts`.
- Produces:

```ts
export const MAX_HTML_BYTES = 10 * 1024 * 1024
export const EMITTER_VERSION = '1'
export interface PublishOptions { dryRun?: boolean; force?: boolean; siteUrlFor?: (doc: Doc) => string | undefined; mmdc?: Mmdc }
export interface PublishResult { created: string[]; updated: string[]; skipped: string[]; blocked: string[]; archived: string[] }
export async function publishDocs(args: { config: Config; docs: Doc[]; client: PlaneApi; lock: Lock; cacheDir: string; options?: PublishOptions }): Promise<PublishResult>
```

**Change detection.** The content hash covers the Markdown body, the frontmatter, every asset's content hash, and `EMITTER_VERSION`. It deliberately does *not* cover the emitted HTML, because the HTML cannot be produced until assets are uploaded — hashing the inputs instead is what lets an unchanged document be skipped without doing any work at all. Bump `EMITTER_VERSION` whenever the emitter's output changes, or existing pages will never be re-rendered.

**The overwrite guard.** Before writing, the publisher fetches the page and hashes its current body. If that hash differs from the one recorded after the last publish, a human has edited the page in Plane. Because an update replaces the entire body, writing would destroy their work, so the document is reported as blocked and skipped. `--force` overrides it; nothing else does.

- [ ] **Step 1: Write the failing test**

`tests/publish.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseDoc } from '../src/parse.js'
import { MAX_HTML_BYTES, publishDocs, type PublishOptions } from '../src/plane/publish.js'
import type { PlaneApi } from '../src/plane/client.js'
import type { Config, Doc, Lock } from '../src/types.js'

const DOC = `---
title: Settlement flow
summary: S
status: current
---

Intro.

\`\`\`mermaid
graph TD; A-->B;
\`\`\`
`

function fixture(body = DOC) {
  const root = mkdtempSync(join(tmpdir(), 'contrail-publish-'))
  writeFileSync(join(root, 'doc.md'), body)
  return { root, doc: parseDoc(join(root, 'doc.md'), root) }
}

const config: Config = {
  root: '/tmp',
  plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
  repos: {},
  docs: ['./*.md'],
}

function fakeClient(overrides: Partial<PlaneApi> = {}): PlaneApi & { calls: string[] } {
  const calls: string[] = []
  const base: PlaneApi = {
    createPage: async () => {
      calls.push('createPage')
      return { id: 'page-1', parentLinkPending: false }
    },
    getPage: async () => {
      calls.push('getPage')
      return { id: 'page-1', name: 'Settlement flow', description_html: '<p>remote</p>', updated_at: '' }
    },
    updatePage: async () => void calls.push('updatePage'),
    archivePage: async () => void calls.push('archivePage'),
    createAssetUpload: async () => {
      calls.push('createAssetUpload')
      return { asset_id: 'asset-1', upload_data: { url: 'https://s3.test', fields: {} } }
    },
    uploadAssetBytes: async () => void calls.push('uploadAssetBytes'),
    confirmAttachment: async () => void calls.push('confirmAttachment'),
  }
  return { ...base, ...overrides, calls }
}

const mmdc = vi.fn(async (_input: string, output: string) => writeFileSync(output, 'stub-png-bytes'))

function run(args: { doc: Doc; root: string; client: PlaneApi; lock: Lock; options?: PublishOptions }) {
  return publishDocs({
    config,
    docs: [args.doc],
    client: args.client,
    lock: args.lock,
    cacheDir: join(args.root, '.cache'),
    options: { ...args.options, mmdc },
  })
}

describe('publishDocs', () => {
  it('creates the page, uploads assets, then replaces the body', async () => {
    const { root, doc } = fixture()
    const client = fakeClient()
    const lock: Lock = { version: 1, docs: {} }

    const result = await run({ doc, root, client, lock })

    expect(result.created).toEqual(['doc.md'])
    expect(client.calls.indexOf('createPage')).toBeLessThan(client.calls.indexOf('createAssetUpload'))
    expect(client.calls.indexOf('uploadAssetBytes')).toBeLessThan(client.calls.indexOf('updatePage'))
    expect(client.calls).toContain('confirmAttachment')
    expect(lock.docs['doc.md']?.pageId).toBe('page-1')
  })

  it('performs no writes on a second publish of unchanged content', async () => {
    const { root, doc } = fixture()
    const lock: Lock = { version: 1, docs: {} }
    await run({ doc, root, client: fakeClient(), lock })
    const stored = structuredClone(lock.docs['doc.md']!)

    // The page still holds exactly what we wrote, so the guard passes and the
    // content hash matches: nothing should happen at all.
    const second = fakeClient({
      getPage: async () => ({
        id: 'page-1',
        name: 'Settlement flow',
        description_html: 'unused by the guard, which compares stored hashes',
        updated_at: '',
      }),
    })
    const result = await run({ doc, root, client: second, lock })

    expect(result.blocked.concat(result.updated)).toEqual([])
    expect(result.skipped).toEqual(['doc.md'])
    expect(second.calls).not.toContain('updatePage')
    expect(second.calls).not.toContain('createAssetUpload')
    expect(lock.docs['doc.md']).toEqual(stored)
  })

  it('refuses to overwrite a page edited in Plane since the last publish', async () => {
    const { root, doc } = fixture()
    const lock: Lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', remoteHash: 'what-we-wrote', assets: {} } },
    }
    const client = fakeClient()

    const result = await run({ doc, root, client, lock })

    expect(result.blocked).toEqual(['doc.md'])
    expect(client.calls).not.toContain('updatePage')
  })

  it('overwrites the human edit when force is set', async () => {
    const { root, doc } = fixture()
    const lock: Lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', remoteHash: 'what-we-wrote', assets: {} } },
    }
    const client = fakeClient()

    const result = await run({ doc, root, client, lock, options: { force: true } })

    expect(result.updated).toEqual(['doc.md'])
    expect(client.calls).toContain('updatePage')
  })

  it('writes nothing during a dry run', async () => {
    const { root, doc } = fixture()
    const client = fakeClient()
    const result = await run({ doc, root, client, lock: { version: 1, docs: {} }, options: { dryRun: true } })

    expect(result.created).toEqual(['doc.md'])
    expect(client.calls).not.toContain('createPage')
    expect(client.calls).not.toContain('updatePage')
  })

  it('rejects a document whose HTML exceeds the Plane payload ceiling', async () => {
    const big = `---\ntitle: T\nsummary: S\nstatus: current\n---\n\n${'x'.repeat(MAX_HTML_BYTES + 1)}\n`
    const { root, doc } = fixture(big)
    await expect(run({ doc, root, client: fakeClient(), lock: { version: 1, docs: {} } })).rejects.toThrow(/10 MB/)
  })

  it('archives the page of a document that no longer exists', async () => {
    const { root } = fixture()
    const client = fakeClient()
    const lock: Lock = {
      version: 1,
      docs: { 'gone.md': { pageId: 'page-9', contentHash: 'c', remoteHash: 'r', assets: {} } },
    }

    const result = await publishDocs({ config, docs: [], client, lock, cacheDir: join(root, '.cache') })

    expect(result.archived).toEqual(['gone.md'])
    expect(client.calls).toContain('archivePage')
    expect(lock.docs['gone.md']?.archived).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/publish.test.ts`
Expected: FAIL — cannot resolve `../src/plane/publish.js`.

- [ ] **Step 3: Implement the publisher**

`src/plane/publish.ts`:

```ts
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import pLimit from 'p-limit'
import { collectAssets, type AssetPlan } from '../assets.js'
import { emitPlane } from '../emit/plane.js'
import { hashContent } from '../lock.js'
import type { Mmdc } from '../render/mermaid.js'
import type { Config, Doc, Lock } from '../types.js'
import type { PlaneApi } from './client.js'

export const MAX_HTML_BYTES = 10 * 1024 * 1024

/** Bump when the emitter's output changes, or existing pages will never re-render. */
export const EMITTER_VERSION = '1'

const CONCURRENCY = 4

export interface PublishOptions {
  dryRun?: boolean
  force?: boolean
  siteUrlFor?: (doc: Doc) => string | undefined
  /** Test seam; production uses the real mermaid renderer. */
  mmdc?: Mmdc
}

export interface PublishResult {
  created: string[]
  updated: string[]
  skipped: string[]
  blocked: string[]
  archived: string[]
}

function contentHashFor(doc: Doc, assets: AssetPlan[]): string {
  return hashContent([
    EMITTER_VERSION,
    doc.body,
    JSON.stringify(doc.frontmatter),
    ...assets.map((asset) => `${asset.id}:${asset.hash}`),
  ])
}

export async function publishDocs(args: {
  config: Config
  docs: Doc[]
  client: PlaneApi
  lock: Lock
  cacheDir: string
  options?: PublishOptions
}): Promise<PublishResult> {
  const { client, lock, cacheDir } = args
  const options = args.options ?? {}
  const result: PublishResult = { created: [], updated: [], skipped: [], blocked: [], archived: [] }
  const limit = pLimit(CONCURRENCY)
  const present = new Set(args.docs.map((doc) => doc.key))

  await Promise.all(
    args.docs.map((doc) =>
      limit(async () => {
        const assets = await collectAssets(doc, { cacheDir, mmdc: options.mmdc })
        const contentHash = contentHashFor(doc, assets)
        const entry = lock.docs[doc.key]
        const isNew = !entry || entry.archived === true

        if (entry && !entry.archived) {
          const remote = await client.getPage(entry.pageId)
          const remoteHash = hashContent([remote.description_html])

          if (entry.remoteHash && remoteHash !== entry.remoteHash && !options.force) {
            result.blocked.push(doc.key)
            return
          }
          if (entry.contentHash === contentHash && !options.force) {
            result.skipped.push(doc.key)
            return
          }
        }

        if (options.dryRun) {
          ;(isNew ? result.created : result.updated).push(doc.key)
          return
        }

        const pageId = isNew
          ? (await client.createPage({ name: doc.frontmatter.title, description_html: '<p>Publishing</p>' })).id
          : entry!.pageId

        const assetIds: Record<string, string> = {}
        for (const asset of assets) {
          const bytes = readFileSync(asset.filePath)
          const upload = await client.createAssetUpload({
            name: basename(asset.filePath),
            type: asset.contentType,
            size: bytes.byteLength,
            entity_identifier: pageId,
          })
          await client.uploadAssetBytes(upload, bytes, asset.contentType, basename(asset.filePath))
          await client.confirmAttachment(pageId, upload.asset_id)
          assetIds[asset.id] = upload.asset_id
        }

        const html = emitPlane(doc, {
          assetIds,
          updated: new Date().toISOString().slice(0, 10),
          siteUrl: options.siteUrlFor?.(doc),
        })

        const size = Buffer.byteLength(html, 'utf8')
        if (size > MAX_HTML_BYTES) {
          throw new Error(
            `${doc.key}: rendered HTML is ${size} bytes, over Plane's 10 MB page limit. ` +
              'Split the document into sub-pages.',
          )
        }

        await client.updatePage(pageId, { name: doc.frontmatter.title, description_html: html })

        lock.docs[doc.key] = {
          pageId,
          contentHash,
          remoteHash: hashContent([html]),
          assets: Object.fromEntries(assets.map((asset) => [asset.id, asset.hash])),
        }
        ;(isNew ? result.created : result.updated).push(doc.key)
      }),
    ),
  )

  for (const [key, entry] of Object.entries(lock.docs)) {
    if (present.has(key) || entry.archived) continue
    if (!options.dryRun) await client.archivePage(entry.pageId)
    lock.docs[key] = { ...entry, archived: true }
    result.archived.push(key)
  }

  return result
}
```

Note that the lockfile's `assets` field stores asset id to **content hash**, while `assetIds` handed to the emitter maps asset id to **Plane UUID**. Both exist because they answer different questions: has this image changed, and what does Plane call it.

Re-uploading every asset on every content change is deliberate for M1 — it is one request per image on a document that changed anyway, and skipping it correctly requires tracking per-asset UUIDs across runs. If diagram-heavy documents make publishes slow, that is the optimisation, and the lockfile already stores the hashes it needs.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/publish.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/plane/publish.ts tests/publish.test.ts
git commit -m "feat: two-phase publisher with overwrite and size guards"
```

---

### Task 12: CLI

**Files:**
- Create: `src/cli.ts`
- Modify: `package.json` (add `tinyglobby`)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `findDocs(config: Config): string[]`; `runInit(cwd: string): string`; `main(argv: string[]): Promise<number>`.

Commands: `init`, `build`, `status`, `publish` with `--dry-run`, `--force` and `--only <substring>`. Argument parsing uses `parseArgs` from `node:util` rather than a dependency.

- [ ] **Step 1: Add the glob dependency**

Run: `npm install tinyglobby@^0.2.10`

`fs.glob` exists in Node 22 but is experimental and prints a runtime warning, which is unacceptable noise in a CLI.

- [ ] **Step 2: Write the failing test**

`tests/cli.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findDocs, runInit } from '../src/cli.js'
import { loadConfig } from '../src/config.js'

describe('runInit', () => {
  it('writes a config file that loads cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-init-'))
    const path = runInit(root)
    expect(existsSync(path)).toBe(true)
    expect(loadConfig(path).plane.workspace).toBeTypeOf('string')
  })

  it('refuses to overwrite an existing config', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-init-'))
    runInit(root)
    expect(() => runInit(root)).toThrow(/already exists/)
  })
})

describe('findDocs', () => {
  it('finds documents across several repositories in one workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-find-'))
    mkdirSync(join(root, 'repo-a', 'docs'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'repo-a', 'docs', 'one.md'), '# one')
    writeFileSync(join(root, 'docs', 'two.md'), '# two')

    const found = findDocs({
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md', './*/docs/**/*.md'],
    })

    expect(found.map((path) => path.split('/').pop()).sort()).toEqual(['one.md', 'two.md'])
  })
})
```

The third test is the multi-repo workspace requirement from the spec, expressed as an assertion.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — cannot resolve `../src/cli.js`.

- [ ] **Step 4: Implement the CLI**

`src/cli.ts`:

```ts
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { globSync } from 'tinyglobby'
import { findConfigPath, loadConfig } from './config.js'
import { loadLock, saveLock } from './lock.js'
import { parseDoc } from './parse.js'
import { PlaneClient } from './plane/client.js'
import { publishDocs } from './plane/publish.js'
import type { Config } from './types.js'

const TEMPLATE = `export default {
  plane: {
    baseUrl: 'https://plane.example.com',
    workspace: 'your-workspace-slug',
  },
  repos: {},
  docs: ['./docs/**/*.md', './*/docs/**/*.md'],
}
`

export function runInit(cwd: string): string {
  const path = join(cwd, 'contrail.config.ts')
  if (existsSync(path)) throw new Error(`${path} already exists.`)
  writeFileSync(path, TEMPLATE)
  return path
}

export function findDocs(config: Config): string[] {
  return globSync(config.docs, { cwd: config.root, absolute: true }).sort()
}

function requireApiKey(): string {
  const key = process.env.PLANE_API_KEY
  if (!key) {
    throw new Error('PLANE_API_KEY is not set. Export it; it must never be stored in a config file.')
  }
  return key
}

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      only: { type: 'string' },
    },
  })

  const command = positionals[0] ?? 'help'

  if (command === 'help') {
    console.log('contrail init | build | status | publish [--dry-run] [--force] [--only <substring>]')
    return 0
  }

  if (command === 'init') {
    console.log(`Created ${runInit(process.cwd())}`)
    return 0
  }

  const config = loadConfig(findConfigPath(process.cwd()))
  const docs = findDocs(config)
    .map((path) => parseDoc(path, config.root))
    .filter((doc) => !values.only || doc.key.includes(values.only))

  if (command === 'build') {
    console.log(`${docs.length} document(s) parsed with no errors.`)
    return 0
  }

  if (command === 'status') {
    const lock = loadLock(config.root)
    for (const doc of docs) {
      const entry = lock.docs[doc.key]
      console.log(`${entry?.pageId ?? 'unpublished'}  ${doc.frontmatter.status.padEnd(8)}  ${doc.key}`)
    }
    return 0
  }

  if (command === 'publish') {
    const lock = loadLock(config.root)
    const client = new PlaneClient({
      baseUrl: config.plane.baseUrl,
      workspace: config.plane.workspace,
      apiKey: requireApiKey(),
    })

    const result = await publishDocs({
      config,
      docs,
      client,
      lock,
      cacheDir: join(config.root, '.contrail', 'cache'),
      options: { dryRun: values['dry-run'], force: values.force },
    })

    if (!values['dry-run']) saveLock(config.root, lock)

    console.log(
      `created ${result.created.length}, updated ${result.updated.length}, ` +
        `skipped ${result.skipped.length}, archived ${result.archived.length}`,
    )
    for (const key of result.blocked) {
      console.error(`BLOCKED  ${key} was edited in Plane since the last publish; nothing was written.`)
      console.error('         Re-publish with --force only if that edit can be discarded.')
    }
    return result.blocked.length > 0 ? 1 : 0
  }

  console.error(`Unknown command: ${command}`)
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
```

Blocked documents exit non-zero so that a scripted publish surfaces the condition instead of silently skipping it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/cli.ts tests/cli.test.ts
git commit -m "feat: CLI with init, build, status and publish"
```

---

### Task 13: Live verification against a real Plane instance

Every previous task is tested without a network. This one settles the assumptions only a real instance can settle — above all, whether an uploaded asset is referenced by its id.

**Files:**
- Create: `tests/integration/plane-live.test.ts`, `docs/verification.md`
- Modify: `src/emit/plane.ts` (only if the finding requires it)

**Interfaces:**
- Consumes: `PlaneClient`, `publishDocs`, `parseDoc`.
- Produces: no new interfaces.

- [ ] **Step 1: Write the integration test, skipped unless credentials are present**

`tests/integration/plane-live.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDoc } from '../../src/parse.js'
import { PlaneClient } from '../../src/plane/client.js'
import { publishDocs } from '../../src/plane/publish.js'
import type { Lock } from '../../src/types.js'

const live =
  Boolean(process.env.PLANE_API_KEY) &&
  Boolean(process.env.PLANE_BASE_URL) &&
  Boolean(process.env.PLANE_WORKSPACE)

describe.skipIf(!live)('live Plane instance', () => {
  it('publishes a document with a diagram and reads it back intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-live-'))
    writeFileSync(
      join(root, 'contrail-smoke.md'),
      '---\ntitle: contrail smoke test\nsummary: Safe to delete.\nstatus: draft\n---\n\n' +
        'Body text.\n\n```mermaid\ngraph TD; A-->B;\n```\n',
    )

    const config = {
      root,
      plane: { baseUrl: process.env.PLANE_BASE_URL!, workspace: process.env.PLANE_WORKSPACE! },
      repos: {},
      docs: ['./*.md'],
    }
    const client = new PlaneClient({ ...config.plane, apiKey: process.env.PLANE_API_KEY! })
    const lock: Lock = { version: 1, docs: {} }

    const result = await publishDocs({
      config,
      docs: [parseDoc(join(root, 'contrail-smoke.md'), root)],
      client,
      lock,
      cacheDir: join(root, '.cache'),
    })

    expect(result.created).toEqual(['contrail-smoke.md'])

    const pageId = lock.docs['contrail-smoke.md']!.pageId
    console.log(`Open this page in Plane before it is archived: page id ${pageId}`)

    const page = await client.getPage(pageId)
    expect(page.description_html).toContain('image-component')
    expect(page.description_html).toContain('Body text')

    await client.archivePage(pageId)
  }, 120_000)
})
```

- [ ] **Step 2: Run it against a real instance**

```bash
PLANE_BASE_URL=https://plane.yourcompany.com \
PLANE_WORKSPACE=your-workspace \
PLANE_API_KEY=your-key \
npx vitest run tests/integration/plane-live.test.ts
```

Expected: PASS. It creates a page named "contrail smoke test" and archives it at the end.

- [ ] **Step 3: Open the page in Plane and confirm the diagram actually renders**

The assertion above only proves the markup survived Plane's sanitizer. It does not prove the image resolves. Open the page in a browser using the page id the test logs, and confirm the diagram appears as a picture rather than a broken image.

If it is broken, `imageSrc()` in `src/emit/plane.ts` is the single place to change: try the `asset_url` value returned by `createAssetUpload` instead of the bare asset id. That will require threading `asset_url` through `assetIds`, which is a small change confined to `publish.ts` and `plane.ts`. Re-run this test afterwards.

- [ ] **Step 4: Record the findings**

Write `docs/verification.md` stating the Plane version tested, whether `image-component` accepts an asset id, what `description_html` looked like when read back, and anything the sanitizer removed. This is what saves the next person from repeating the investigation.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/plane-live.test.ts docs/verification.md src/emit/plane.ts
git commit -m "test: live Plane verification and recorded findings"
```

---

## Done when

- `npx vitest run` passes and `npx tsc --noEmit` is clean.
- `contrail publish` creates wiki pages with rendered diagrams in a real workspace.
- Running `contrail publish` twice writes nothing the second time.
- Editing a published page in Plane and re-publishing reports it blocked and changes nothing.
- `docs/verification.md` records what was confirmed against the live instance.

## Not in this plan

M2 (static site and Vercel), M3 (inbox, ADRs, capture, staleness, `INDEX.md`) and M4 (the Claude Code plugin) each get their own plan. The seams already exist: `PublishOptions.siteUrlFor` is where M2 attaches, and the blocked-document path in the CLI is where M3's `capture --plane-edits` attaches.

**Page hierarchy is also deferred, deliberately.** The `plane.collection` and `plane.parent`
frontmatter fields are parsed and validated by Task 2, but Task 11 does not send `parent_id` or
`collection_id`, so M1 publishes a flat set of wiki pages. Two reasons: `parent_id` introduces a
publish-ordering dependency (a parent must exist before its children, which the flat
`Promise.all` in Task 11 does not guarantee), and `collection_id` requires resolving a collection
name through the Collections API, whose endpoints have not been verified the way the seven in
this plan were. Both belong in one focused follow-up plan that can establish the ordering and
verify those endpoints properly. Until then, pages are organised by hand in Plane, which the
create-only placement rule was always going to preserve anyway.
