import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSite } from '../src/emit/site.js'
import { parseDoc } from '../src/parse.js'

function writeAt(root: string, rel: string, frontmatter: string) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, frontmatter)
  return parseDoc(path, root)
}

const FM = (extra = '') => `---\ntitle: T\nsummary: S\nstatus: current\n${extra}---\n\nBody.\n`

describe('Task 5: persistent section nav', () => {
  it('renders the nav (a pure link list, no JavaScript) on every emitted page, including the index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-everywhere-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview], outDir, cacheDir: join(root, '.cache') })

    for (const file of ['index.html', '01-overview/index.html', '01-overview/brief.html']) {
      const page = readFileSync(join(outDir, file), 'utf8')
      expect(page).toContain('class="section-nav"')
      expect(page).toContain('aria-label="Documentation sections"')
      // Requirement 1: works with JavaScript disabled — plain links, no script at all.
      expect(page).not.toContain('<script')
    }
  })

  it('marks the active section on a document page with `aria-current="page"`, and nowhere else', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-active-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM())
    const management = writeAt(root, 'docs/03-management/budget.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview, management], outDir, cacheDir: join(root, '.cache') })

    const briefPage = readFileSync(join(outDir, '01-overview', 'brief.html'), 'utf8')
    expect(briefPage).toContain('<a href="../01-overview/index.html" aria-current="page">Overview &amp; Initiation</a>')
    expect(briefPage).not.toContain('aria-current="page">Management &amp; Operations')

    const budgetPage = readFileSync(join(outDir, '03-management', 'budget.html'), 'utf8')
    expect(budgetPage).toContain('<a href="../03-management/index.html" aria-current="page">Management &amp; Operations</a>')
    expect(budgetPage).not.toContain('aria-current="page">Overview &amp; Initiation')
  })

  it('omits the tab (and the landing page) for a section with no visible document in a client build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-empty-section-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM('audience: client\n'))
    const management = writeAt(root, 'docs/03-management/budget.md', FM()) // internal only
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview, management], outDir, cacheDir: join(root, '.cache'), audience: 'client' })

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(index).toContain('Overview &amp; Initiation')
    expect(index).not.toContain('Management &amp; Operations')
    expect(existsSync(join(outDir, '03-management', 'index.html'))).toBe(false)
    expect(existsSync(join(outDir, '01-overview', 'index.html'))).toBe(true)
  })

  it('a full internal build (nothing excluded) renders a tab for every section that has documents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-full-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM())
    const management = writeAt(root, 'docs/03-management/budget.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview, management], outDir, cacheDir: join(root, '.cache') })

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(index).toContain('Overview &amp; Initiation')
    expect(index).toContain('Management &amp; Operations')
  })

  it('tab hrefs resolve correctly from a two-level-deep page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-deep-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM())
    const decision = writeAt(root, 'docs/03-management/decisions/0001-x.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview, decision], outDir, cacheDir: join(root, '.cache') })

    const deepPagePath = join(outDir, '03-management', 'decisions', '0001-x.html')
    const deepPage = readFileSync(deepPagePath, 'utf8')
    const navBlock = /<nav class="section-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(deepPage)![1]!
    const hrefs = [...navBlock.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)

    expect(hrefs).toEqual(['../../01-overview/index.html', '../../03-management/index.html'])
    for (const href of hrefs) {
      const resolved = resolve(dirname(deepPagePath), href)
      expect(existsSync(resolved)).toBe(true)
    }
  })

  it('the index renders without JS: no <script> tag anywhere, and every nav entry is a plain <a>', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-nojs-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview], outDir, cacheDir: join(root, '.cache') })

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(index).not.toContain('<script')
    expect(index).not.toContain('role="tab"')
    expect(index).not.toContain('role="tablist"')
  })
})
