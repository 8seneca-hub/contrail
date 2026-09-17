import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSite } from '../src/emit/site.js'
import { parseDoc } from '../src/parse.js'
import { collectRawFiles } from '../src/raw-files.js'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'contrail-fileblock-'))
  mkdirSync(join(root, 'docs', '02-planning'), { recursive: true })
  mkdirSync(join(root, 'raw'), { recursive: true })
  writeFileSync(join(root, 'raw', 'estimate.xlsx'), 'pretend spreadsheet bytes')
  writeFileSync(
    join(root, 'docs', '02-planning', 'estimate.md'),
    '---\ntitle: Estimate\nsummary: Effort and cost.\nstatus: current\ndocKind: estimate\n' +
      'nodiagram: "The numbers are a table, not a shape."\n---\n\n' +
      'Estimated bottom-up from the signed spreadsheet.\n\n' +
      '```file {src=raw/estimate.xlsx, summary="Signed Austria estimate, 14 July."}\n```\n',
  )
  return { root, docs: [parseDoc(join(root, 'docs', '02-planning', 'estimate.md'), root)] }
}

describe('a file block publishes raw material and links to it', () => {
  it('copies the raw file into the build so it reaches object storage', async () => {
    const { root, docs } = workspace()
    const outDir = join(root, 'site')
    const rawFiles = collectRawFiles(root, ['./raw/**/*'])
    await buildSite({ docs, outDir, cacheDir: join(root, '.cache'), rawFiles } as never)

    expect(rawFiles).toHaveLength(1)
    expect(existsSync(join(outDir, rawFiles[0]!.outPath))).toBe(true)
  })

  it('links it from the HTML, with its size, as a download', async () => {
    const { root, docs } = workspace()
    const outDir = join(root, 'site')
    const rawFiles = collectRawFiles(root, ['./raw/**/*'])
    await buildSite({ docs, outDir, cacheDir: join(root, '.cache'), rawFiles } as never)

    const page = readFileSync(join(outDir, '02-planning', 'estimate.html'), 'utf8')
    expect(page).toContain('Signed Austria estimate, 14 July.')
    // Relative, because the docs endpoint serves the build from a path nothing
    // can predict at build time.
    expect(page).toMatch(/href="\.\.\/files\/[a-f0-9]{16}\.xlsx"/)
    expect(page).toContain('download')
    expect(page).toContain('estimate.xlsx')
  })

  it('links it from the .md too — the agent copy must not lose the attachment', async () => {
    const { root, docs } = workspace()
    const outDir = join(root, 'site')
    const rawFiles = collectRawFiles(root, ['./raw/**/*'])
    await buildSite({ docs, outDir, cacheDir: join(root, '.cache'), rawFiles } as never)

    const md = readFileSync(join(outDir, '02-planning', 'estimate.md'), 'utf8')
    expect(md).toContain('Signed Austria estimate, 14 July.')
    expect(md).toMatch(/\]\(\.\.\/files\/[a-f0-9]{16}\.xlsx\)/)
  })

  it('fails loudly when the block names a file no `files` glob collected', async () => {
    const { root, docs } = workspace()
    await expect(
      buildSite({ docs, outDir: join(root, 'site'), cacheDir: join(root, '.cache'), rawFiles: [] } as never),
    ).rejects.toThrow(/raw\/estimate\.xlsx/)
  })
})
