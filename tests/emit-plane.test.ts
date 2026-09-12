import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import rehypeParse from 'rehype-parse'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Code } from 'mdast'
import { describe, expect, it } from 'vitest'
import { assetIdForDiagram, assetIdForFile } from '../src/assets.js'
import { emitPlane } from '../src/emit/plane.js'
import { planeSchema } from '../src/emit/plane-schema.js'
import { parseDoc } from '../src/parse.js'
import type { Doc } from '../src/types.js'

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

function makeDoc(body: string, status = 'current'): Doc {
  const root = mkdtempSync(join(tmpdir(), 'contrail-plane-'))
  writeFileSync(join(root, 'doc.md'), `---\ntitle: T\nsummary: S\nstatus: ${status}\n---\n\n${body}`)
  return parseDoc(join(root, 'doc.md'), root)
}

function doc(status = 'current'): Doc {
  return makeDoc(BODY, status)
}

// Never re-type a diagram literal to compute an expected id: pull the actual node
// value out of the parsed tree, since remark's `code` node value carries no
// trailing newline (unlike a hand-typed fixture string).
function diagramSource(d: Doc): string {
  let value: string | undefined
  visit(d.tree, 'code', (node: Code) => {
    if (node.lang === 'mermaid') value = node.value
  })
  if (value === undefined) throw new Error('fixture has no mermaid block')
  return value
}

function sanitized(htmlString: string): string {
  return String(
    unified()
      .use(rehypeParse, { fragment: true })
      .use(rehypeSanitize, planeSchema)
      .use(rehypeStringify)
      .processSync(htmlString),
  )
}

const ctx = {
  assetIds: {
    [assetIdForDiagram(diagramSource(doc()))]: 'asset-diagram-uuid',
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
    expect(sanitized(html)).toBe(html)
  })

  describe('comprehensive coverage', () => {
    it('a document with none of the special blocks still emits valid sanitized HTML', () => {
      const plain = 'Just a plain paragraph.\n\nAnother one with **bold** text.\n'
      const d = makeDoc(plain)
      const html = emitPlane(d, { assetIds: {}, updated: '2026-09-12' })
      expect(html).toContain('Just a plain paragraph.')
      expect(html).toContain('<strong>bold</strong>')
      expect(sanitized(html)).toBe(html)
    })

    it.each([
      ['NOTE', '#eff6ff', '128161'],
      ['TIP', '#ecfdf5', '128161'],
      ['IMPORTANT', '#eef2ff', '10071'],
      ['WARNING', '#fffbeb', '9888'],
      ['CAUTION', '#fef2f2', '9940'],
    ])('alert kind %s produces its correct background and emoji codepoint', (kind, background, emoji) => {
      const d = makeDoc(`> [!${kind}]\n> Body text for ${kind}.\n`)
      const html = emitPlane(d, { assetIds: {}, updated: '2026-09-12' })
      expect(html).toContain(`data-background="${background}"`)
      expect(html).toContain(`data-emoji-unicode="${emoji}"`)
      expect(html).toContain(`Body text for ${kind}.`)
    })

    it("an alert's multi-paragraph content survives", () => {
      const d = makeDoc('> [!NOTE]\n> First paragraph.\n>\n> Second paragraph.\n')
      const html = emitPlane(d, { assetIds: {}, updated: '2026-09-12' })
      expect(html).toContain('First paragraph.')
      expect(html).toContain('Second paragraph.')
      expect(sanitized(html)).toBe(html)
    })

    it("an alert's list content survives", () => {
      const d = makeDoc('> [!TIP]\n> Intro.\n>\n> - one\n> - two\n')
      const html = emitPlane(d, { assetIds: {}, updated: '2026-09-12' })
      expect(html).toContain('<ul>')
      expect(html).toContain('<li>one</li>')
      expect(html).toContain('<li>two</li>')
      expect(sanitized(html)).toBe(html)
    })

    it('a missing diagram asset id throws a clear error naming the document', () => {
      const d = doc()
      expect(() => emitPlane(d, { assetIds: {}, updated: '2026-09-12' })).toThrow(/doc\.md/)
      expect(() => emitPlane(d, { assetIds: {}, updated: '2026-09-12' })).toThrow(/diagram/)
    })

    it('a missing artifact fallback asset id throws a clear error naming the document', () => {
      const d = makeDoc(
        '```artifact {fallback="./flow.png", summary="An interactive settlement explorer."}\n<div id="explorer"></div>\n```\n',
      )
      expect(() => emitPlane(d, { assetIds: {}, updated: '2026-09-12' })).toThrow(/doc\.md/)
      expect(() => emitPlane(d, { assetIds: {}, updated: '2026-09-12' })).toThrow(/fallback/)
    })

    it('status: current emits no status callout', () => {
      const html = emitPlane(doc('current'), { assetIds: ctx.assetIds, updated: ctx.updated })
      expect(html).not.toMatch(/Draft —|In review —|Stale —/)
    })

    it.each(['draft', 'review', 'stale'] as const)('status: %s emits its status callout', (status) => {
      const html = emitPlane(doc(status), { assetIds: ctx.assetIds, updated: ctx.updated })
      const messages = { draft: 'Draft', review: 'In review', stale: 'Stale' }
      expect(html).toContain('callout-component')
      expect(html).toMatch(new RegExp(messages[status]))
    })

    it('siteUrl absent emits no interactive-version callout', () => {
      const html = emitPlane(doc(), { assetIds: ctx.assetIds, updated: ctx.updated })
      expect(html).not.toContain('Interactive version')
    })

    it('the footer contains the document key and status', () => {
      const html = emitPlane(doc('review'), { assetIds: ctx.assetIds, updated: ctx.updated })
      expect(html).toContain('doc.md')
      expect(html).toContain('status: review')
    })

    it('escapes HTML special characters in an artifact summary instead of injecting them raw', () => {
      const d = makeDoc(
        '```artifact {fallback="./flow.png", summary="<script>alert(1)</script> & friends"}\n<div id="x"></div>\n```\n',
      )
      const html = emitPlane(d, { assetIds: { [assetIdForFile('./flow.png')]: 'uuid' }, updated: '2026-09-12' })
      expect(html).not.toContain('<script>')
      // rehype-stringify escapes with numeric entities rather than named ones, and
      // (correctly, per the HTML spec) only escapes the opening `<`, not `>` in text.
      // Either way the raw `<script>` tag must never appear unescaped.
      expect(html).toMatch(/&#x3C;script>|&lt;script&gt;/)
      expect(html).toMatch(/&#x26;|&amp;/)
      expect(sanitized(html)).toBe(html)
    })

    it('does not mutate the input Doc tree', () => {
      const d = doc()
      const snapshot = JSON.stringify(d.tree)
      emitPlane(d, ctx)
      expect(JSON.stringify(d.tree)).toBe(snapshot)
    })
  })
})
