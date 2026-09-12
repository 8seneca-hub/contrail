import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { visit } from 'unist-util-visit'
import type { Code } from 'mdast'
import { collectAssets, assetIdForDiagram, assetIdForFile } from '../src/assets.js'
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

  it('assigns image/jpeg, image/svg+xml, and application/octet-stream by fallback extension', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-assets-types-'))
    writeFileSync(join(root, 'flow.jpg'), 'jpg-bytes')
    writeFileSync(join(root, 'flow.svg'), '<svg></svg>')
    writeFileSync(join(root, 'flow.xyz'), 'mystery-bytes')
    const body = `${FRONTMATTER}\`\`\`artifact {fallback="./flow.jpg", summary="jpg"}
<div></div>
\`\`\`

\`\`\`artifact {fallback="./flow.svg", summary="svg"}
<div></div>
\`\`\`

\`\`\`artifact {fallback="./flow.xyz", summary="unknown"}
<div></div>
\`\`\`
`
    const doc = writeDoc(root, body)
    const mmdc = fakeMmdc()
    const assets = await collectAssets(doc, { cacheDir: join(root, '.cache'), mmdc })

    expect(assets.map((a) => a.contentType)).toEqual([
      'image/jpeg',
      'image/svg+xml',
      'application/octet-stream',
    ])
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
