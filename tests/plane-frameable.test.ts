import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unframeablePages } from '../src/deploy/plane-docs.js'

function buildDir(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'contrail-frameable-'))
  for (const [rel, html] of Object.entries(pages)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, html)
  }
  return dir
}

describe('unframeablePages', () => {
  it('names a page that would fetch its diagram, because Plane refuses to frame it', () => {
    const dir = buildDir({
      '01-overview/domain-research.html':
        '<html><body><figure class="diagram"><iframe src="../diagrams/abc.html"></iframe></figure></body></html>',
    })
    expect(unframeablePages(dir)).toEqual(['01-overview/domain-research.html'])
  })

  it('passes a page whose diagram is inlined with srcdoc', () => {
    const dir = buildDir({
      '01-overview/domain-research.html':
        '<html><body><figure class="diagram"><iframe srcdoc="&lt;html&gt;&lt;/html&gt;" ' +
        'data-diagram-src="../diagrams/abc.html"></iframe></figure></body></html>',
    })
    expect(unframeablePages(dir)).toEqual([])
  })

  it('ignores the standalone diagram files themselves — they are framed by nobody', () => {
    const dir = buildDir({
      'diagrams/abc.html': '<html><body><iframe src="../diagrams/nested.html"></iframe></body></html>',
      'index.html': '<html><body>No diagrams here.</body></html>',
    })
    expect(unframeablePages(dir)).toEqual([])
  })

  it('ignores an iframe pointing somewhere other than a diagram', () => {
    const dir = buildDir({
      'index.html': '<html><body><iframe src="https://example.com/embed"></iframe></body></html>',
    })
    expect(unframeablePages(dir)).toEqual([])
  })
})
