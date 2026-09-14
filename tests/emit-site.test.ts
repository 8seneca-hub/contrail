import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

  it('Task 1: reads ?theme from the query string and forwards it to nested diagram iframes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-theme-'))
    const doc = writeDoc(root, 'doc.md', `${FRONTMATTER}Body.\n`)
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    const head = /<head>([\s\S]*?)<\/head>/.exec(page)![1]!
    expect(head).toContain('<script>')
    expect(head).toContain('URLSearchParams(location.search).get("theme")')
    expect(head).toContain('document.documentElement.setAttribute("data-theme",t)')
    // The opaque-origin iframe can't read Plane's theme itself, so the parent forwards it.
    expect(head).toContain('u.searchParams.set("theme",t)')
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

  it('keeps loading="lazy" on the diagram iframe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-lazy-'))
    writeFileSync(join(root, 'a.workflow.json'), '{"nodes":[]}')
    const doc = writeDoc(
      root,
      'doc.md',
      `${FRONTMATTER}\`\`\`archify {type=workflow, src=./a.workflow.json, summary="A diagram."}
\`\`\`
`,
    )
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), archify: { runner: okArchifyRunner() } })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('loading="lazy"')
  })

  it('renders a [!WARNING] alert as a styled callout with the marker text gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-alert-'))
    const doc = writeDoc(
      root,
      'doc.md',
      `${FRONTMATTER}> [!WARNING]
> This is dangerous.
`,
    )
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('callout-warning')
    expect(page).toContain('This is dangerous.')
    expect(page).not.toContain('[!WARNING]')
    // The blockquote must be gone entirely — this is a callout, not a quote.
    expect(page).not.toContain('<blockquote>')
  })

  it('renders each of the five alert kinds as its own callout class', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-alert-kinds-'))
    const doc = writeDoc(
      root,
      'doc.md',
      `${FRONTMATTER}> [!NOTE]
> A note.

> [!TIP]
> A tip.

> [!IMPORTANT]
> Important stuff.

> [!WARNING]
> A warning.

> [!CAUTION]
> Be careful.
`,
    )
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    for (const cls of ['callout-note', 'callout-tip', 'callout-important', 'callout-warning', 'callout-caution']) {
      expect(page).toContain(cls)
    }
    for (const marker of ['[!NOTE]', '[!TIP]', '[!IMPORTANT]', '[!WARNING]', '[!CAUTION]']) {
      expect(page).not.toContain(marker)
    }
  })

  it('leaves an ordinary blockquote untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-quote-'))
    const doc = writeDoc(root, 'doc.md', `${FRONTMATTER}> Just a quote, not an alert.\n`)
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('<blockquote>')
    expect(page).toContain('Just a quote, not an alert.')
    expect(page).not.toContain('callout')
  })
})

describe('Fix 5: the site mirrors the source doc tree instead of flattening it', () => {
  it('emits a nested page at the section path, not a flattened docs__section__file.html', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-nest-'))
    mkdirSync(join(root, 'docs', '04-technical'), { recursive: true })
    writeFileSync(join(root, 'docs', '04-technical', 'prd.md'), `${FRONTMATTER}The PRD.\n`)
    const doc = parseDoc(join(root, 'docs', '04-technical', 'prd.md'), root)

    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    expect(existsSync(join(outDir, '04-technical', 'prd.html'))).toBe(true)
    expect(existsSync(join(outDir, 'docs__04-technical__prd.html'))).toBe(false)
  })

  it('rewrites a relative link between two documents so it resolves, crossing sections in both directions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-crosslink-'))
    mkdirSync(join(root, 'docs', '04-technical'), { recursive: true })
    mkdirSync(join(root, 'docs', '03-management'), { recursive: true })
    writeFileSync(
      join(root, 'docs', '04-technical', 'prd.md'),
      `${FRONTMATTER}See the [budget](../03-management/budget.md) for cost detail.\n`,
    )
    writeFileSync(
      join(root, 'docs', '03-management', 'budget.md'),
      `${FRONTMATTER}See the [PRD](../04-technical/prd.md) for scope.\n`,
    )
    const prd = parseDoc(join(root, 'docs', '04-technical', 'prd.md'), root)
    const budget = parseDoc(join(root, 'docs', '03-management', 'budget.md'), root)

    const outDir = join(root, 'out')
    await buildSite({ docs: [prd, budget], outDir, cacheDir: join(root, '.cache') })

    const prdPage = readFileSync(join(outDir, '04-technical', 'prd.html'), 'utf8')
    const budgetPage = readFileSync(join(outDir, '03-management', 'budget.html'), 'utf8')

    const prdHref = /<a href="([^"]+)">budget<\/a>/.exec(prdPage)?.[1]
    const budgetHref = /<a href="([^"]+)">PRD<\/a>/.exec(budgetPage)?.[1]
    expect(prdHref).toBeDefined()
    expect(budgetHref).toBeDefined()

    // Resolve each href against the page that actually carries it — the way
    // a browser would — and confirm it lands on the real emitted file, not
    // just that the string looks plausible.
    const resolvedFromPrd = resolve(dirname(join(outDir, '04-technical', 'prd.html')), prdHref!)
    const resolvedFromBudget = resolve(dirname(join(outDir, '03-management', 'budget.html')), budgetHref!)
    expect(resolvedFromPrd).toBe(join(outDir, '03-management', 'budget.html'))
    expect(resolvedFromBudget).toBe(join(outDir, '04-technical', 'prd.html'))
  })

  it('a diagram embedded two levels deep still resolves its iframe src', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-deep-diagram-'))
    mkdirSync(join(root, 'docs', '03-management', 'decisions'), { recursive: true })
    writeFileSync(join(root, 'docs', '03-management', 'decisions', 'x.workflow.json'), '{"nodes":[]}')
    writeFileSync(
      join(root, 'docs', '03-management', 'decisions', '0001-x.md'),
      `${FRONTMATTER}\`\`\`archify {type=workflow, src=./x.workflow.json, summary="A decision flow."}
\`\`\`
`,
    )
    const doc = parseDoc(join(root, 'docs', '03-management', 'decisions', '0001-x.md'), root)

    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), archify: { runner: okArchifyRunner() } })

    const page = readFileSync(join(outDir, '03-management', 'decisions', '0001-x.html'), 'utf8')
    const src = /<iframe src="([^"]+)"/.exec(page)?.[1]
    expect(src).toBeDefined()
    const resolved = resolve(dirname(join(outDir, '03-management', 'decisions', '0001-x.html')), src!)
    expect(existsSync(resolved)).toBe(true)
    expect(resolved.startsWith(join(outDir, 'diagrams') + '/')).toBe(true)
  })
})

describe('Fix 5: the index groups documents by section', () => {
  function writeAt(root: string, rel: string, frontmatter: string) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, frontmatter)
    return parseDoc(path, root)
  }

  it('groups by section in numeric order, titles sub-directories, excludes 00-meta, and puts the rest under Other', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-index-groups-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', '---\ntitle: Brief\nsummary: S\nstatus: current\n---\n\nBody.\n')
    const meeting = writeAt(
      root,
      'docs/03-management/meetings/2026-01-01.md',
      '---\ntitle: Meeting\nsummary: S\nstatus: current\n---\n\nBody.\n',
    )
    const decision = writeAt(
      root,
      'docs/03-management/decisions/0001-x.md',
      '---\ntitle: Decision\nsummary: S\nstatus: current\n---\n\nBody.\n',
    )
    const qa = writeAt(
      root,
      'docs/05-delivery/qa-reports/report.md',
      '---\ntitle: QA Report\nsummary: S\nstatus: current\n---\n\nBody.\n',
    )
    const meta = writeAt(root, 'docs/00-meta/notes.md', '---\ntitle: Meta Notes\nsummary: S\nstatus: current\n---\n\nBody.\n')
    const stray = writeAt(root, 'random.md', '---\ntitle: Stray\nsummary: S\nstatus: current\n---\n\nBody.\n')

    const outDir = join(root, 'out')
    await buildSite({ docs: [overview, meeting, decision, qa, meta, stray], outDir, cacheDir: join(root, '.cache') })

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')

    // Task 5: the nav lists every non-empty section as a tab, in numeric order, with the virtual
    // "Other" tab last — and the index shows only the first non-empty section (Overview) inline.
    expect(index).toContain('Overview &amp; Initiation')
    expect(index).toContain('Brief')
    // The other sections show up only as nav tabs, never with their own content inlined.
    expect(index).not.toContain('<h2>Management &amp; Operations</h2>')
    expect(index).not.toContain('Meetings')
    expect(index).not.toContain('Stray')

    const overviewAt = index.indexOf('>Overview &amp; Initiation <')
    const managementAt = index.indexOf('>Management &amp; Operations <')
    const deliveryAt = index.indexOf('>Testing &amp; Handover <')
    const otherAt = index.indexOf('>Other <')
    expect(overviewAt).toBeGreaterThanOrEqual(0)
    expect(overviewAt).toBeLessThan(managementAt)
    expect(managementAt).toBeLessThan(deliveryAt)
    expect(deliveryAt).toBeLessThan(otherAt)
    // 02-planning and 04-technical have no documents in this build — no tab for either.
    expect(index).not.toContain('Planning &amp; Scope')
    expect(index).not.toContain('Technical &amp; Design')

    // Each section's own landing page carries its own content, reachable from the shared nav.
    const management = readFileSync(join(outDir, '03-management', 'index.html'), 'utf8')
    expect(management).toContain('Meetings')
    expect(management).toContain('Decisions')

    const delivery = readFileSync(join(outDir, '05-delivery', 'index.html'), 'utf8')
    expect(delivery).toContain('QA Reports')

    const other = readFileSync(join(outDir, 'other', 'index.html'), 'utf8')
    expect(other).toContain('Stray')

    // 00-meta is machine metadata, never a document — excluded entirely, not merely folded into
    // "Other", and absent from every page including its own would-be landing page.
    for (const page of [index, management, delivery, other]) {
      expect(page).not.toContain('Meta Notes')
    }
    expect(existsSync(join(outDir, '00-meta', 'index.html'))).toBe(false)
  })
})

describe('Task 2: a .md file is emitted alongside every page', () => {
  it("a build writes <page>.md next to <page>.html with the document's Markdown content", async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-md-'))
    const doc = writeDoc(root, 'doc.md', `${FRONTMATTER}Some **bold** prose.\n`)
    const outDir = join(root, 'out')

    const result = await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    expect(result.markdownFiles).toBe(1)
    expect(existsSync(join(outDir, 'doc.html'))).toBe(true)
    const md = readFileSync(join(outDir, 'doc.md'), 'utf8')
    expect(md).toContain('Some **bold** prose.')
  })

  it('a --audience client build writes no .md for an internal-only document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-site-md-audience-'))
    const clientDoc = writeDoc(
      root,
      'brief.md',
      '---\ntitle: Brief\nsummary: S\nstatus: current\naudience: client\n---\n\nClient-visible.\n',
    )
    const internalDoc = writeDoc(
      root,
      'budget.md',
      '---\ntitle: Budget\nsummary: S\nstatus: current\naudience: internal\n---\n\nInternal only.\n',
    )
    const outDir = join(root, 'out')

    const result = await buildSite({
      docs: [clientDoc, internalDoc],
      outDir,
      cacheDir: join(root, '.cache'),
      audience: 'client',
    })

    // Same filter, same reason as the page itself: an internal document's .md must not
    // leak into a client build any more than its .html does.
    expect(result.markdownFiles).toBe(1)
    expect(existsSync(join(outDir, 'brief.md'))).toBe(true)
    expect(existsSync(join(outDir, 'budget.md'))).toBe(false)
    expect(existsSync(join(outDir, 'budget.html'))).toBe(false)
  })
})
