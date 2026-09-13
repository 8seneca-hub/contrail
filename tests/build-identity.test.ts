import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSite } from '../src/emit/site.js'
import { parseDoc } from '../src/parse.js'

const FM = (extra = '') => `---\ntitle: Doc\nsummary: S\nstatus: current\n${extra}---\n\nBody.\n`

function writeDoc(root: string, name: string, contents: string) {
  const path = join(root, name)
  writeFileSync(path, contents)
  return parseDoc(path, root)
}

/** Every file written under `dir`, read as utf8 and concatenated — so a single `.not.toContain`
 * check can prove a word never appears anywhere in an emitted tree, not just in one page. */
function allEmittedBytes(dir: string): string {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((entry) => !entry.endsWith('.css') && statSync(join(dir, entry)).isFile())
    .map((entry) => readFileSync(join(dir, entry), 'utf8'))
    .join('\n---\n')
}

describe('Task 1: build identity', () => {
  it("an internal build's <title> carries the project name with an explicit (internal) marker, on the index too", async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-identity-internal-'))
    const doc = writeDoc(root, 'doc.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), projectName: 'Meridian Portal' })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('<title>Doc · Meridian Portal (internal)</title>')

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(index).toContain('<title>Meridian Portal (internal)</title>')
    expect(index).toContain('<h1>Meridian Portal</h1>')
  })

  it("a client build's <title> carries the project name with NO marker, on the index too", async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-identity-client-'))
    const doc = writeDoc(root, 'doc.md', FM('audience: client\n'))
    const outDir = join(root, 'out')
    await buildSite({
      docs: [doc],
      outDir,
      cacheDir: join(root, '.cache'),
      projectName: 'Meridian Portal',
      audience: 'client',
    })

    const page = readFileSync(join(outDir, 'doc.html'), 'utf8')
    expect(page).toContain('<title>Doc · Meridian Portal</title>')
    expect(page).not.toContain('(internal)')

    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(index).toContain('<title>Meridian Portal</title>')
    expect(index).not.toContain('(internal)')
  })

  it('an internal build renders the banner on every page, including the index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-identity-banner-internal-'))
    const doc = writeDoc(root, 'doc.md', FM())
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache') })

    const BANNER = 'Internal — contains commercial information. Not for client distribution.'
    expect(readFileSync(join(outDir, 'doc.html'), 'utf8')).toContain(BANNER)
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toContain(BANNER)
  })

  it('a client build renders no banner at all, and the word "internal" appears nowhere in its emitted bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-identity-banner-client-'))
    const doc = writeDoc(root, 'doc.md', FM('audience: client\n'))
    const outDir = join(root, 'out')
    await buildSite({ docs: [doc], outDir, cacheDir: join(root, '.cache'), audience: 'client' })

    const bytes = allEmittedBytes(outDir)
    expect(bytes.toLowerCase()).not.toContain('internal')
  })

  it('the print stylesheet keeps the banner visible (`@media print` never hides it)', () => {
    const css = readFileSync(new URL('../templates/site.css', import.meta.url), 'utf8')
    const printBlockMatch = /@media print\s*\{([\s\S]*?)\n\}/.exec(css)
    expect(printBlockMatch).not.toBeNull()
    expect(printBlockMatch![1]).toContain('.notice-banner')
    // The one CSS file both audiences copy verbatim must never carry the word "internal" itself —
    // only the (client-build-only) HTML the banner renders on may say it.
    expect(css.toLowerCase()).not.toContain('internal')
  })
})
