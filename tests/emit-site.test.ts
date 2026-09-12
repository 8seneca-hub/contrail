import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildSite } from '../src/emit/site.js'
import { parseDoc } from '../src/parse.js'
import type { ArchifyRunner } from '../src/render/archify.js'
import type { Mmdc } from '../src/render/mermaid.js'

const FRONTMATTER = `---
title: T
summary: S
status: current
---

`

function writeDoc(root: string, name: string, body: string) {
  const path = join(root, name)
  writeFileSync(path, body)
  return parseDoc(path, root)
}

function okArchifyRunner(): ArchifyRunner {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'render') writeFileSync(args[3]!, '<html>diagram artifact</html>')
    return { stdout: '{"ok":true}', code: 0 }
  })
}

function fakeMmdc(): Mmdc {
  return vi.fn(async (_i: string, o: string) => writeFileSync(o, 'stub-png'))
}

describe('buildSite', () => {
  it('a document with two diagrams produces two iframes and two copied files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-'))
    writeFileSync(join(root, 'a.workflow.json'), '{"nodes":["a"]}')
    writeFileSync(join(root, 'b.workflow.json'), '{"nodes":["b"]}')
    const doc = writeDoc(
      root,
      'doc.md',
      `${FRONTMATTER}\`\`\`archify {type=workflow, src=./a.workflow.json, summary="First diagram."}
\`\`\`

\`\`\`archify {type=workflow, src=./b.workflow.json, summary="Second diagram."}
\`\`\`
`,
    )
    const outDir = join(root, 'out')
    const result = await buildSite({
      docs: [doc],
      outDir,
      cacheDir: join(root, '.cache'),
      archify: { runner: okArchifyRunner() },
    })

    expect(result.diagrams).toBe(2)
    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    const iframeCount = (page.match(/<iframe /g) ?? []).length
    expect(iframeCount).toBe(2)

    // Two copied diagram files under diagrams/
    const diagramSrcs = [...page.matchAll(/<iframe src="([^"]+)"/g)].map((m) => m[1]!)
    expect(diagramSrcs).toHaveLength(2)
    for (const src of diagramSrcs) {
      expect(existsSync(join(outDir, src))).toBe(true)
    }
  })

  it('the summary reaches both the iframe title attribute and the figcaption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-caption-'))
    writeFileSync(join(root, 'a.workflow.json'), '{"nodes":[]}')
    const doc = writeDoc(
      root,
      'doc.md',
      `${FRONTMATTER}\`\`\`archify {type=workflow, src=./a.workflow.json, summary="How the tool call flows."}
\`\`\`
`,
    )
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), archify: { runner: okArchifyRunner() } })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('title="How the tool call flows."')
    expect(page).toContain('<figcaption>How the tool call flows.</figcaption>')
  })

  it('a document with no diagrams still renders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-nodiagrams-'))
    const doc = writeDoc(root, 'doc.md', `${FRONTMATTER}Just prose, no diagrams at all.\n`)
    const outDir = join(root, 'out')
    const result = await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    expect(result.diagrams).toBe(0)
    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('Just prose, no diagrams at all.')
    expect(page).not.toContain('<iframe')
  })

  it('escapes HTML special characters in a title and summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-escape-'))
    writeFileSync(join(root, 'a.workflow.json'), '{"nodes":[]}')
    const doc = writeDoc(
      root,
      'doc.md',
      `---
title: 'Tags <b> & "quotes"'
summary: S
status: current
---

\`\`\`archify {type=workflow, src=./a.workflow.json, summary='Flow <b>bold</b> & "quoted"'}
\`\`\`
`,
    )
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), archify: { runner: okArchifyRunner() } })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    // Raw special characters must never appear unescaped in the title or the iframe title attribute.
    expect(page).not.toContain('<b>bold</b>')
    expect(page).not.toContain('Tags <b> & "quotes"')
    expect(page).toContain('&lt;b&gt;')
    expect(page).toContain('&amp;')
    expect(page).toContain('&quot;quoted&quot;')
    // The page HTML must still be well-formed: the escaped iframe title attribute
    // must not break out into a second attribute or tag.
    expect(page).toMatch(/<iframe src="[^"]+" loading="lazy" title="[^"]*">/)
  })

  it('emits an index.html listing every document with title, summary and status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-index-'))
    const docA = writeDoc(
      root,
      'a.md',
      '---\ntitle: Doc A\nsummary: Summary A\nstatus: current\n---\n\nBody A.\n',
    )
    const docB = writeDoc(
      root,
      'b.md',
      '---\ntitle: Doc B\nsummary: Summary B\nstatus: draft\n---\n\nBody B.\n',
    )
    const outDir = join(root, 'out')
    await buildSite({ docs: [docA, docB], outDir, cacheDir: join(root, '.cache') })

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(index).toContain('Doc A')
    expect(index).toContain('Summary A')
    expect(index).toContain('status-current')
    expect(index).toContain('Doc B')
    expect(index).toContain('Summary B')
    expect(index).toContain('status-draft')
    expect(index).toContain('href="a.html"')
    expect(index).toContain('href="b.html"')
  })

  it('copies templates/site.css into the output and links it from every page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-css-'))
    const doc = writeDoc(root, 'doc.md', `${FRONTMATTER}Body.\n`)
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    expect(existsSync(join(outDir, 'site.css'))).toBe(true)
    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('<link rel="stylesheet" href="site.css">')
  })

  it('renders a mermaid diagram as an image and an artifact block as a captioned figure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-mixed-'))
    writeFileSync(join(root, 'flow.png'), 'png-bytes')
    const doc = writeDoc(
      root,
      'doc.md',
      `${FRONTMATTER}\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`artifact {fallback="./flow.png", summary="An explorer"}
<div id="explorer"></div>
\`\`\`
`,
    )
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), mmdc: fakeMmdc() })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('<img src="assets/')
    expect(page).toContain('<figcaption>An explorer</figcaption>')
  })
})
