import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSite } from '../src/emit/site.js'
import { parseDoc } from '../src/parse.js'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'contrail-font-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(
    join(root, 'docs', 'brief.md'),
    '---\ntitle: Brief\nsummary: S\nstatus: current\ndocKind: charter\nnodiagram: "Fixture."\n---\n\nZjedené — záverečná správa.\n',
  )
  return { root, docs: [parseDoc(join(root, 'docs', 'brief.md'), root)] }
}

describe('the site ships the font Plane uses', () => {
  it('copies Inter into the build, so it is not fetched from a CDN the CSP blocks', async () => {
    const { root, docs } = workspace()
    const outDir = join(root, 'site')
    await buildSite({ docs, outDir, cacheDir: join(root, '.cache') } as never)

    // The docs endpoint serves `default-src 'self'`, so an external font URL is
    // blocked outright — and `font/woff2` is on the upload whitelist precisely
    // so the font can travel with the build.
    expect(existsSync(join(outDir, 'fonts', 'inter-latin-wght-normal.woff2'))).toBe(true)
    // latin-ext carries the Slovak and Czech diacritics this project's own
    // documents are written in.
    expect(existsSync(join(outDir, 'fonts', 'inter-latin-ext-wght-normal.woff2'))).toBe(true)
  })

  it('declares Inter and uses it as the body font, matching Plane', async () => {
    const { root, docs } = workspace()
    const outDir = join(root, 'site')
    await buildSite({ docs, outDir, cacheDir: join(root, '.cache') } as never)

    const css = readFileSync(join(outDir, 'site.css'), 'utf8')
    expect(css).toContain("font-family: 'Inter Variable'")
    expect(css).toContain('fonts/inter-latin-wght-normal.woff2')
    expect(css).toMatch(/unicode-range/)
    // The old stack led with a monospace face, which is why the pages did not
    // look like the application they are embedded in.
    expect(css).not.toMatch(/font:[^;]*JetBrains Mono/)
  })
})
