import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { diagramHash, renderMermaid } from '../src/render/mermaid.js'

const SOURCE = 'graph TD;\n  A-->B;\n'

function fakeMmdc() {
  return vi.fn(async (_input: string, output: string) => {
    writeFileSync(output, 'stub')
  })
}

describe('renderMermaid', () => {
  it('renders png and svg and reports the hash', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const mmdc = fakeMmdc()
    const result = await renderMermaid(SOURCE, cache, mmdc)
    expect(result.hash).toBe(diagramHash(SOURCE))
    expect(existsSync(result.pngPath)).toBe(true)
    expect(existsSync(result.svgPath)).toBe(true)
    expect(mmdc).toHaveBeenCalledTimes(2)
  })

  it('does not re-render when the cache already holds both outputs', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const mmdc = fakeMmdc()
    await renderMermaid(SOURCE, cache, mmdc)
    mmdc.mockClear()
    await renderMermaid(SOURCE, cache, mmdc)
    expect(mmdc).not.toHaveBeenCalled()
  })

  it('gives different hashes to different diagrams', () => {
    expect(diagramHash('graph TD; A-->B;')).not.toBe(diagramHash('graph TD; A-->C;'))
  })

  it('renders only the missing output when one half of the cache is present', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const mmdc = fakeMmdc()
    const first = await renderMermaid(SOURCE, cache, mmdc)
    // Simulate a partially-populated cache: drop the svg on disk without
    // touching the png, then re-render and confirm only the svg is rebuilt.
    const fs = await import('node:fs')
    fs.rmSync(first.svgPath)
    mmdc.mockClear()
    const second = await renderMermaid(SOURCE, cache, mmdc)
    expect(mmdc).toHaveBeenCalledTimes(1)
    expect(mmdc).toHaveBeenCalledWith(expect.stringContaining(second.hash), second.svgPath)
  })

  it('does not touch the .mmd input file on a cache hit', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'contrail-cache-'))
    const mmdc = fakeMmdc()
    const first = await renderMermaid(SOURCE, cache, mmdc)
    const mmdPath = join(cache, 'mermaid', `${first.hash}.mmd`)
    expect(existsSync(mmdPath)).toBe(true)

    // Tamper with the cached input file, then re-render the same source.
    // A genuine cache hit must short-circuit before the unconditional
    // `writeFileSync(inputFile, source)` — so the tampered content must
    // survive untouched. If the early-return were removed, this write would
    // fire again and silently restore the original source, masking the bug.
    writeFileSync(mmdPath, 'tampered')
    mmdc.mockClear()
    await renderMermaid(SOURCE, cache, mmdc)

    expect(mmdc).not.toHaveBeenCalled()
    expect(readFileSync(mmdPath, 'utf8')).toBe('tampered')
  })
})
