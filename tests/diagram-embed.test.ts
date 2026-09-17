import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSite } from '../src/emit/site.js'
import { parseDoc } from '../src/parse.js'

/** A stand-in for a rendered Archify document: self-contained, with the markers
 * the real one carries (a `data-theme` on <html>, and characters that must
 * survive being inlined into an attribute). */
const DIAGRAM_HTML =
  '<!DOCTYPE html><html lang="en" data-theme="dark" data-preset="signal-flow"><head>' +
  '<title>Diagram</title></head><body><svg viewBox="0 0 10 10"></svg>' +
  '<script>var q = "quoted" && 1 < 2;</script></body></html>'

function workspace(): { root: string; docs: ReturnType<typeof parseDoc>[] } {
  const root = mkdtempSync(join(tmpdir(), 'contrail-embed-'))
  mkdirSync(join(root, 'docs', 'diagrams'), { recursive: true })
  writeFileSync(join(root, 'docs', 'diagrams', 'sys.architecture.json'), JSON.stringify({ diagram_type: 'architecture' }))
  writeFileSync(
    join(root, 'docs', 'architecture.md'),
    '---\ntitle: Architecture\nsummary: The shape.\nstatus: current\ndocKind: architecture\n---\n\n' +
      'Three services behind a gateway.\n\n' +
      '```archify {type=architecture, src=./diagrams/sys.architecture.json, summary="How it fits."}\n```\n',
  )
  return { root, docs: [parseDoc(join(root, 'docs', 'architecture.md'), root)] }
}

/** Stands in for the Archify CLI: `renderArchify` invokes
 * `render <type> <ir> <outPath>` and then copies `<outPath>`, so the fake has
 * to write the file where it is told rather than return a path. */
const fakeArchify = {
  runner: async (args: string[]) => {
    writeFileSync(args[3] as string, DIAGRAM_HTML)
    return { stdout: '', code: 0 }
  },
}

describe('diagrams are inlined, not fetched', () => {
  it('embeds the diagram with srcdoc so no second HTTP request is made', async () => {
    const { root, docs } = workspace()
    const outDir = join(root, 'site')

    await buildSite({ docs, outDir, cacheDir: join(root, '.cache'), archify: fakeArchify } as never)

    const page = readFileSync(join(outDir, 'architecture.html'), 'utf8')
    expect(page).toContain('<iframe srcdoc=')
    // The framing denial this fixes comes from the nested document being
    // FETCHED: Plane serves it with `X-Frame-Options: SAMEORIGIN` and
    // `frame-ancestors 'self'`, and our page sits on an opaque origin inside
    // Plane's sandbox, so it is never "self". srcdoc never hits the network.
    expect(page).not.toMatch(/<iframe[^>]*\ssrc="[^"]*diagrams\//)
  })

  it('escapes the diagram so its own quotes and scripts survive the attribute', async () => {
    const { root, docs } = workspace()
    const outDir = join(root, 'site')

    await buildSite({ docs, outDir, cacheDir: join(root, '.cache'), archify: fakeArchify } as never)

    const page = readFileSync(join(outDir, 'architecture.html'), 'utf8')
    // A raw `"` inside srcdoc would end the attribute and truncate the diagram.
    const srcdoc = /<iframe srcdoc="([^"]*)"/.exec(page)?.[1] ?? ''
    expect(srcdoc).toContain('&quot;quoted&quot;')
    expect(srcdoc).toContain('&amp;&amp;')
    expect(srcdoc.length).toBeGreaterThan(100)
  })

  it('still writes the standalone diagram file, so it can be opened on its own', async () => {
    const { root, docs } = workspace()
    const outDir = join(root, 'site')

    const result = await buildSite({ docs, outDir, cacheDir: join(root, '.cache'), archify: fakeArchify } as never)

    expect(result.diagrams).toBe(1)
  })
})
