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
      // Requirement 1: works with JavaScript disabled — the nav itself is a pure link list.
      // (Task 1 adds a theme-bridge script elsewhere in <head>; it has nothing to do with the nav.)
      const navBlock = /<nav class="section-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(page)![1]!
      expect(navBlock).not.toContain('<script')
    }
  })

  it('marks the active section on a document page with `aria-current="page"`, and nowhere else', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-active-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM())
    const management = writeAt(root, 'docs/03-management/budget.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview, management], outDir, cacheDir: join(root, '.cache') })

    const briefPage = readFileSync(join(outDir, '01-overview', 'brief.html'), 'utf8')
    expect(briefPage).toContain(
      '<a href="../01-overview/index.html" aria-current="page">Overview &amp; Initiation <span class="tab-count">1</span></a>',
    )
    expect(briefPage).not.toContain('aria-current="page">Management &amp; Operations')

    const budgetPage = readFileSync(join(outDir, '03-management', 'budget.html'), 'utf8')
    expect(budgetPage).toContain(
      '<a href="../03-management/index.html" aria-current="page">Management &amp; Operations <span class="tab-count">1</span></a>',
    )
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

  it('the index nav renders without JS: no <script> inside the nav, and every entry is a plain <a>', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-nojs-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview], outDir, cacheDir: join(root, '.cache') })

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    // Task 1 adds a theme-bridge script to the page's <head>; the nav itself stays script-free.
    const navBlock = /<nav class="section-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(index)![1]!
    expect(navBlock).not.toContain('<script')
    expect(index).not.toContain('role="tab"')
    expect(index).not.toContain('role="tablist"')
  })
})

describe('FIX B: sub-tab order is by consultation priority, not alphabetical', () => {
  it('orders `03-management`\'s sub-tabs Meetings, Decisions, Change Requests — not alphabetically', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-subtab-order-'))
    const changeRequest = writeAt(root, 'docs/03-management/change-requests/0001-x.md', FM())
    const decision = writeAt(root, 'docs/03-management/decisions/0001-x.md', FM())
    const meeting = writeAt(root, 'docs/03-management/meetings/2026-01-01.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [changeRequest, decision, meeting], outDir, cacheDir: join(root, '.cache') })

    const management = readFileSync(join(outDir, '03-management', 'index.html'), 'utf8')
    const meetingsAt = management.indexOf('>Meetings ')
    const decisionsAt = management.indexOf('>Decisions ')
    const changeRequestsAt = management.indexOf('>Change Requests ')
    expect(meetingsAt).toBeGreaterThanOrEqual(0)
    expect(meetingsAt).toBeLessThan(decisionsAt)
    expect(decisionsAt).toBeLessThan(changeRequestsAt)
  })

  it('falls back to alphabetical for an unlisted sub-folder, after every named priority folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-subtab-fallback-'))
    const meeting = writeAt(root, 'docs/03-management/meetings/2026-01-01.md', FM())
    const zzz = writeAt(root, 'docs/03-management/zzz-misc/note.md', FM())
    const aaa = writeAt(root, 'docs/03-management/aaa-misc/note.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [meeting, zzz, aaa], outDir, cacheDir: join(root, '.cache') })

    const management = readFileSync(join(outDir, '03-management', 'index.html'), 'utf8')
    const meetingsAt = management.indexOf('>Meetings ')
    const aaaAt = management.indexOf('>Aaa Misc ')
    const zzzAt = management.indexOf('>Zzz Misc ')
    expect(meetingsAt).toBeGreaterThanOrEqual(0)
    expect(meetingsAt).toBeLessThan(aaaAt)
    expect(aaaAt).toBeLessThan(zzzAt)
  })
})

describe('FIX C: a directory-level README.md is not a document', () => {
  it('excludes README.md from a tab\'s document count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-readme-count-'))
    const readme = writeAt(root, 'docs/03-management/meetings/README.md', FM())
    const meeting = writeAt(root, 'docs/03-management/meetings/2026-01-01.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [readme, meeting], outDir, cacheDir: join(root, '.cache') })

    const management = readFileSync(join(outDir, '03-management', 'index.html'), 'utf8')
    expect(management).toContain('Meetings <span class="tab-count">1</span>')
  })

  it('a directory containing only a README shows no tab at all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-readme-only-'))
    const overview = writeAt(root, 'docs/01-overview/brief.md', FM())
    const readme = writeAt(root, 'docs/03-management/meetings/README.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [overview, readme], outDir, cacheDir: join(root, '.cache') })

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(index).not.toContain('Management &amp; Operations')
    expect(existsSync(join(outDir, '03-management', 'index.html'))).toBe(false)
  })
})
