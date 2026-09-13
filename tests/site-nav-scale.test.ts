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

const FM = (title: string) => `---\ntitle: ${title}\nsummary: S\nstatus: current\n---\n\nBody.\n`

/** Every `<h3>` heading text inside `<main>`, in document order — the year-group headings
 * (Task 6) are the only `<h3>`s a leaf list ever renders. */
function h3sIn(html: string): string[] {
  return [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]!)
}

/** Every document title (the link text of a `.doc-entry`) inside `<main>`, in rendered order. */
function docTitlesIn(html: string): string[] {
  return [...html.matchAll(/<a href="[^"]+">([^<]+)<\/a>\s*\n<span class="status/g)].map((m) => m[1]!)
}

describe('Task 6 at scale: 40 date-named meetings and 25 numbered ADRs', () => {
  function buildScaleTree(root: string) {
    const docs = []
    // 25 meetings in 2026 (Jan through late), 15 in 2025 — two years, so year-grouping has
    // something real to group, and the total (40) sits well past YEAR_GROUP_THRESHOLD (25).
    for (let i = 0; i < 25; i++) {
      const day = String((i % 28) + 1).padStart(2, '0')
      const month = String((i % 12) + 1).padStart(2, '0')
      const date = `2026-${month}-${day}`
      docs.push(writeAt(root, `docs/03-management/meetings/${date}-standup-${i}.md`, FM(`Standup ${i}`)))
    }
    for (let i = 0; i < 15; i++) {
      const day = String((i % 28) + 1).padStart(2, '0')
      const month = String((i % 12) + 1).padStart(2, '0')
      const date = `2025-${month}-${day}`
      docs.push(writeAt(root, `docs/03-management/meetings/${date}-standup-old-${i}.md`, FM(`Old standup ${i}`)))
    }
    // 25 numbered ADRs, 0001 through 0025.
    for (let i = 1; i <= 25; i++) {
      const n = String(i).padStart(4, '0')
      docs.push(writeAt(root, `docs/03-management/decisions/${n}-decision-${i}.md`, FM(`Decision ${i}`)))
    }
    return docs
  }

  it('meetings appear newest-first, grouped by year (newest year first); ADRs appear 0001 upward, ungrouped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-scale-'))
    const docs = buildScaleTree(root)
    const outDir = join(root, 'out')
    await buildSite({ docs, outDir, cacheDir: join(root, '.cache') })

    const meetings = readFileSync(join(outDir, '03-management', 'meetings', 'index.html'), 'utf8')
    const meetingYears = h3sIn(meetings)
    expect(meetingYears).toEqual(['2026', '2025']) // newest year first

    // Newest-first within the whole list: the last 2026 date generated (day 25, i=24 -> month 01
    // day 25) is NOT necessarily the max — recompute the true max/min from what was written.
    const meetingTitles = docTitlesIn(meetings)
    expect(meetingTitles.length).toBe(40)
    expect(meetingTitles[0]).toMatch(/^Standup /) // a 2026 meeting leads
    expect(meetingTitles[meetingTitles.length - 1]).toMatch(/^Old standup /) // a 2025 meeting trails

    // Every 2026 entry appears before every 2025 entry — newest-first holds across the whole list,
    // not only within each year group.
    const firstOldIndex = meetingTitles.findIndex((t) => t.startsWith('Old standup'))
    const lastNewIndex = meetingTitles.map((t, idx) => (t.startsWith('Standup ') ? idx : -1)).filter((i) => i >= 0).pop()!
    expect(lastNewIndex).toBeLessThan(firstOldIndex)

    const decisions = readFileSync(join(outDir, '03-management', 'decisions', 'index.html'), 'utf8')
    expect(h3sIn(decisions)).toEqual([]) // number-ordered lists never group, regardless of length
    const decisionTitles = docTitlesIn(decisions)
    expect(decisionTitles).toHaveLength(25)
    expect(decisionTitles[0]).toBe('Decision 1')
    expect(decisionTitles[24]).toBe('Decision 25')
    // Strictly ascending 0001 → 0025.
    const numbers = decisionTitles.map((t) => Number(/Decision (\d+)/.exec(t)![1]))
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBeGreaterThan(numbers[i - 1]!)
  })

  it('the tab counts on `03-management`\'s own bar match the real numbers (Meetings 40, Decisions 25)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-scale-counts-'))
    const docs = buildScaleTree(root)
    const outDir = join(root, 'out')
    await buildSite({ docs, outDir, cacheDir: join(root, '.cache') })

    const management = readFileSync(join(outDir, '03-management', 'index.html'), 'utf8')
    expect(management).toContain('Meetings <span class="tab-count">40</span>')
    expect(management).toContain('Decisions <span class="tab-count">25</span>')
  })

  it('the nav resolves correctly from the deepest page (a meeting three levels down)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-nav-scale-deep-'))
    const docs = buildScaleTree(root)
    const outDir = join(root, 'out')
    await buildSite({ docs, outDir, cacheDir: join(root, '.cache') })

    const deepDoc = docs.find((d) => d.key.includes('standup-0.md'))!
    const deepPagePath = join(outDir, ...deepDoc.key.replace(/^docs\//, '').replace(/\.md$/, '.html').split('/'))
    expect(existsSync(deepPagePath)).toBe(true)
    const deepPage = readFileSync(deepPagePath, 'utf8')

    // Both bars present: the persistent top-level one, and management's own (Task 6) with
    // "Meetings" active.
    const bars = [...deepPage.matchAll(/<nav class="([^"]+)"[^>]*>([\s\S]*?)<\/nav>/g)]
    expect(bars).toHaveLength(2)
    expect(bars[1]![1]).toContain('sub-nav')
    expect(bars[1]![2]).toContain('aria-current="page">Meetings')

    for (const bar of bars) {
      const hrefs = [...bar[2]!.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)
      expect(hrefs.length).toBeGreaterThan(0)
      for (const href of hrefs) {
        const resolved = resolve(dirname(deepPagePath), href)
        expect(existsSync(resolved)).toBe(true)
      }
    }
  })
})
