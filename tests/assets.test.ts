import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { visit } from 'unist-util-visit'
import type { Code } from 'mdast'
import {
  collectAssets,
  collectDiagrams,
  assetIdForDiagram,
  assetIdForFile,
  diagramIdFor,
} from '../src/assets.js'
import { archifyHash, type ArchifyRunner } from '../src/render/archify.js'
import { parseDoc } from '../src/parse.js'
import type { Doc } from '../src/types.js'

const FRONTMATTER = `---
title: T
summary: S
status: current
---

`

const DOC = `${FRONTMATTER}\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`artifact {fallback="./flow.png", summary="An explorer"}
<div id="explorer"></div>
\`\`\`
`

function fakeMmdc() {
  return vi.fn(async (_i: string, o: string) => writeFileSync(o, 'stub'))
}

/**
 * Pull the actual parsed source of every mermaid code node out of a Doc, in
 * document order. remark's `code.value` does NOT include the fence's
 * trailing newline, so ids for tests must be derived from this — never from
 * a hand-typed string literal that guesses at whitespace.
 */
function mermaidSources(doc: Doc): string[] {
  const sources: string[] = []
  visit(doc.tree, 'code', (node: Code) => {
    if (node.lang === 'mermaid') sources.push(node.value)
  })
  return sources
}

function writeDoc(root: string, body: string): Doc {
  const path = join(root, 'doc.md')
  writeFileSync(path, body)
  return parseDoc(path, root)
}

describe('collectAssets', () => {
  it('collects one asset per diagram and per artifact fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-'))
    writeFileSync(join(root, 'flow.png'), 'png-bytes')
    const doc = writeDoc(root, DOC)
    const mmdc = fakeMmdc()
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })

    const [diagramSource] = mermaidSources(doc)
    expect(diagramSource).toBeDefined()

    expect(assets).toHaveLength(2)
    expect(assets.map((a) => a.id)).toEqual([
      assetIdForDiagram(diagramSource!),
      assetIdForFile('./flow.png'),
    ])
    expect(assets[1]!.contentType).toBe('image/png')
  })

  it('fails when an artifact fallback file does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-missing-'))
    const doc = writeDoc(root, DOC)
    const mmdc = fakeMmdc()
    await expect(collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })).rejects.toThrow(
      /flow\.png/,
    )
  })

  it('names both the missing file and the document location in the error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-missing-where-'))
    const doc = writeDoc(root, DOC)
    const mmdc = fakeMmdc()
    await expect(collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })).rejects.toThrow(
      /doc\.md:\d+.*flow\.png/,
    )
  })

  it('returns an empty plan for a document with no diagrams and no artifact blocks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-empty-'))
    const doc = writeDoc(root, `${FRONTMATTER}Just prose, no code blocks at all.\n`)
    const mmdc = fakeMmdc()
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })
    expect(assets).toEqual([])
    expect(mmdc).not.toHaveBeenCalled()
  })

  it('collapses two identical diagrams to one cache entry but still returns a plan for each', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-dup-'))
    const body = `${FRONTMATTER}\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`mermaid
graph TD; A-->B;
\`\`\`
`
    const doc = writeDoc(root, body)
    const mmdc = fakeMmdc()
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })

    expect(assets).toHaveLength(2)
    expect(assets[0]!.id).toBe(assets[1]!.id)
    expect(assets[0]!.hash).toBe(assets[1]!.hash)
    expect(assets[0]!.filePath).toBe(assets[1]!.filePath)
    // Second diagram is a cache hit: only the first diagram's png+svg render.
    expect(mmdc).toHaveBeenCalledTimes(2)
  })

  it('gives two different diagrams distinct hashes and distinct files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-distinct-'))
    const body = `${FRONTMATTER}\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`mermaid
graph TD; A-->C;
\`\`\`
`
    const doc = writeDoc(root, body)
    const mmdc = fakeMmdc()
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })

    expect(assets).toHaveLength(2)
    expect(assets[0]!.id).not.toBe(assets[1]!.id)
    expect(assets[0]!.hash).not.toBe(assets[1]!.hash)
    expect(assets[0]!.filePath).not.toBe(assets[1]!.filePath)
    expect(mmdc).toHaveBeenCalledTimes(4)
  })

  it('preserves document order for an interleaved artifact then mermaid then artifact block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-order-'))
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'a.png'), 'a-bytes')
    writeFileSync(join(root, 'b.png'), 'b-bytes')
    const body = `${FRONTMATTER}\`\`\`artifact {fallback="./a.png", summary="First"}
<div id="a"></div>
\`\`\`

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`artifact {fallback="./b.png", summary="Second"}
<div id="b"></div>
\`\`\`
`
    const doc = writeDoc(root, body)
    const [diagramSource] = mermaidSources(doc)
    const mmdc = fakeMmdc()
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })

    expect(assets.map((a) => a.id)).toEqual([
      assetIdForFile('./a.png'),
      assetIdForDiagram(diagramSource!),
      assetIdForFile('./b.png'),
    ])
  })

  it('assigns the correct content type for every CONTENT_TYPES entry, plus an unknown extension', async () => {
    // Table-driven over the full mapping so a typo in any single entry (e.g.
    // '.gif' mapped to the wrong mime type) is caught, not just the couple
    // of extensions a hand-picked sample would happen to cover.
    const cases: ReadonlyArray<readonly [ext: string, expected: string]> = [
      ['.png', 'image/png'],
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.gif', 'image/gif'],
      ['.webp', 'image/webp'],
      ['.svg', 'image/svg+xml'],
      ['.xyz', 'application/octet-stream'],
    ]

    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-types-'))
    for (const [ext] of cases) {
      writeFileSync(join(root, `flow${ext}`), `bytes for ${ext}`)
    }
    const blocks = cases
      .map(
        ([ext], i) => `\`\`\`artifact {fallback="./flow${ext}", summary="case ${i}"}
<div></div>
\`\`\``,
      )
      .join('\n\n')
    const doc = writeDoc(root, `${FRONTMATTER}${blocks}\n`)
    const mmdc = fakeMmdc()
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })

    expect(assets.map((a) => a.contentType)).toEqual(cases.map(([, expected]) => expected))
  })

  it('genuinely avoids invoking the renderer on a cache hit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-cachehit-'))
    const doc = writeDoc(root, DOC.replace('flow.png', 'flow.png'))
    writeFileSync(join(root, 'flow.png'), 'png-bytes')
    const cacheDir = join(root, '.cache')

    const firstMmdc = fakeMmdc()
    await collectAssets(doc, { cacheDir, mmdc: firstMmdc })
    expect(firstMmdc).toHaveBeenCalledTimes(2)

    const secondMmdc = fakeMmdc()
    await collectAssets(doc, { cacheDir, mmdc: secondMmdc })
    expect(secondMmdc).not.toHaveBeenCalled()
  })
})

function okArchifyRunner(): ArchifyRunner {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'render') writeFileSync(args[3]!, '<html>diagram</html>')
    return { stdout: '{"ok":true}', code: 0 }
  })
}

describe('collectDiagrams', () => {
  it('collects one DiagramPlan per archify block, never touching AssetPlan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-diagrams-'))
    writeFileSync(join(root, 'flow.workflow.json'), '{"nodes":[]}')
    const body = `${FRONTMATTER}\`\`\`archify {type=workflow, src=./flow.workflow.json, summary="How the tool call flows."}
\`\`\`
`
    const doc = writeDoc(root, body)
    const runner = okArchifyRunner()
    const diagrams = await collectDiagrams(doc, { cacheDir: join(root, '.cache'), archify: { runner } })

    expect(diagrams).toHaveLength(1)
    expect(diagrams[0]!.meta).toEqual({
      type: 'workflow',
      src: './flow.workflow.json',
      summary: 'How the tool call flows.',
    })
    expect(diagrams[0]!.id).toBe(diagramIdFor(diagrams[0]!.hash))
    expect(existsSync(diagrams[0]!.htmlPath)).toBe(true)

    // The diagram must never leak into collectAssets' image-upload plan.
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache') })
    expect(assets).toEqual([])
  })

  it('leaves collectAssets blind to archify blocks even when mermaid/artifact are also present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-diagrams-mixed-'))
    writeFileSync(join(root, 'flow.workflow.json'), '{"nodes":[]}')
    writeFileSync(join(root, 'flow.png'), 'png-bytes')
    const body = `${FRONTMATTER}\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`archify {type=workflow, src=./flow.workflow.json, summary="A workflow diagram."}
\`\`\`

\`\`\`artifact {fallback="./flow.png", summary="An explorer"}
<div id="explorer"></div>
\`\`\`
`
    const doc = writeDoc(root, body)
    const mmdc = fakeMmdc()
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })
    expect(assets).toHaveLength(2)
    expect(assets.every((a) => !a.id.startsWith('archify:'))).toBe(true)
  })

  it('throws naming the location and the missing IR file when src does not resolve', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-diagrams-missing-'))
    const body = `${FRONTMATTER}\`\`\`archify {type=workflow, src=./nope.workflow.json, summary="Missing."}
\`\`\`
`
    const doc = writeDoc(root, body)
    const runner = okArchifyRunner()
    await expect(
      collectDiagrams(doc, { cacheDir: join(root, '.cache'), archify: { runner } }),
    ).rejects.toThrow(/doc\.md:\d+.*nope\.workflow\.json/)
  })

  it('a cache hit invokes the archify runner zero times', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-diagrams-cache-'))
    writeFileSync(join(root, 'flow.workflow.json'), '{"nodes":[]}')
    const body = `${FRONTMATTER}\`\`\`archify {type=workflow, src=./flow.workflow.json, summary="A workflow diagram."}
\`\`\`
`
    const doc = writeDoc(root, body)
    const cacheDir = join(root, '.cache')
    const first = okArchifyRunner()
    await collectDiagrams(doc, { cacheDir, archify: { runner: first } })

    const second = okArchifyRunner()
    await collectDiagrams(doc, { cacheDir, archify: { runner: second } })
    expect(second).not.toHaveBeenCalled()
  })

  it('gives two different IR sources distinct hashes and ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-diagrams-distinct-'))
    writeFileSync(join(root, 'a.workflow.json'), '{"nodes":["a"]}')
    writeFileSync(join(root, 'b.workflow.json'), '{"nodes":["b"]}')
    const body = `${FRONTMATTER}\`\`\`archify {type=workflow, src=./a.workflow.json, summary="A."}
\`\`\`

\`\`\`archify {type=workflow, src=./b.workflow.json, summary="B."}
\`\`\`
`
    const doc = writeDoc(root, body)
    const runner = okArchifyRunner()
    const diagrams = await collectDiagrams(doc, { cacheDir: join(root, '.cache'), archify: { runner } })

    expect(diagrams).toHaveLength(2)
    expect(diagrams[0]!.hash).not.toBe(diagrams[1]!.hash)
    expect(diagrams[0]!.id).not.toBe(diagrams[1]!.id)
    expect(diagrams[0]!.hash).toBe(archifyHash('{"nodes":["a"]}'))
  })

  it('returns an empty plan for a document with no archify blocks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-diagrams-empty-'))
    const doc = writeDoc(root, `${FRONTMATTER}Just prose.\n`)
    const runner = okArchifyRunner()
    const diagrams = await collectDiagrams(doc, { cacheDir: join(root, '.cache'), archify: { runner } })
    expect(diagrams).toEqual([])
    expect(runner).not.toHaveBeenCalled()
  })
})
