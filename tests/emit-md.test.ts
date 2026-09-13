import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitMarkdown } from '../src/emit/md.js'
import { parseDoc } from '../src/parse.js'

const DOC = `---
title: T
summary: S
status: current
---

Intro.

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`artifact {fallback="./flow.png", summary="An interactive settlement explorer."}
<div id="explorer"></div>
\`\`\`
`

function doc(contents: string = DOC) {
  const root = mkdtempSync(join(tmpdir(), 'contrail-md-'))
  writeFileSync(join(root, 'doc.md'), contents)
  return parseDoc(join(root, 'doc.md'), root)
}

describe('emitMarkdown', () => {
  it('keeps mermaid fences intact for agents', () => {
    const out = emitMarkdown(doc())
    expect(out).toContain('```mermaid')
    // Also verify the diagram body is preserved verbatim
    expect(out).toContain('graph TD; A-->B;')
  })

  it('replaces artifact blocks with the fallback image and summary', () => {
    const out = emitMarkdown(doc())
    expect(out).toContain('![An interactive settlement explorer.](./flow.png)')
    expect(out).toContain('An interactive settlement explorer.')
    expect(out).not.toContain('<div id="explorer">')
  })

  describe('comprehensive coverage', () => {
    it('document with NO artifact blocks passes through with content intact', () => {
      const noArtifact = `---
title: T
summary: S
status: current
---

# Main Heading

Introduction text with **bold** and _italic_.

\`\`\`mermaid
graph LR; X-->Y;
\`\`\`

Some trailing text.
`
      const out = emitMarkdown(doc(noArtifact))
      expect(out).toContain('# Main Heading')
      expect(out).toContain('Introduction text')
      expect(out).toContain('**bold**')
      // remark-stringify may convert _italic_ to *italic*, both are valid
      expect(out).toMatch(/\*italic\*|_italic_/)
      expect(out).toContain('```mermaid')
      expect(out).toContain('Some trailing text')
    })

    it('GFM TABLE survives the round trip', () => {
      const withTable = `---
title: T
summary: S
status: current
---

# Table Test

| Header 1 | Header 2 |
|----------|----------|
| Cell A   | Cell B   |
| Cell C   | Cell D   |

End of table.
`
      const out = emitMarkdown(doc(withTable))
      // A table should still have pipe characters
      expect(out).toContain('|')
      expect(out).toContain('Header 1')
      expect(out).toContain('Header 2')
      expect(out).toContain('Cell A')
      // Check it's not degraded to garbage - should have proper formatting
      const lines = out.split('\n')
      const hasTableLine = lines.some(line => line.includes('|') && line.includes('Header'))
      expect(hasTableLine).toBe(true)
      // Verify the separator row (alignment/dashes) is present to catch partial serialization regressions
      const hasSeparatorLine = lines.some(line => line.includes('|') && line.includes('-'))
      expect(hasSeparatorLine).toBe(true)
    })

    it('MULTIPLE artifact blocks in one document are all flattened', () => {
      const multiArtifact = `---
title: T
summary: S
status: current
---

First artifact:

\`\`\`artifact {fallback="./img1.png", summary="First diagram."}
<div id="artifact1"></div>
\`\`\`

Middle content.

Second artifact:

\`\`\`artifact {fallback="./img2.png", summary="Second diagram."}
<div id="artifact2"></div>
\`\`\`

End.
`
      const out = emitMarkdown(doc(multiArtifact))
      // Both images should be present
      expect(out).toContain('![First diagram.](./img1.png)')
      expect(out).toContain('![Second diagram.](./img2.png)')
      // Both summaries should be present
      expect(out).toContain('First diagram.')
      expect(out).toContain('Second diagram.')
      // No artifact div content
      expect(out).not.toContain('<div id="artifact1">')
      expect(out).not.toContain('<div id="artifact2">')
    })

    it('two artifact blocks back-to-back with no content between are both flattened', () => {
      const backToBackArtifacts = `---
title: T
summary: S
status: current
---

\`\`\`artifact {fallback="./a.png", summary="First."}
<div id="first"></div>
\`\`\`

\`\`\`artifact {fallback="./b.png", summary="Second."}
<div id="second"></div>
\`\`\`

End.
`
      const out = emitMarkdown(doc(backToBackArtifacts))
      // Both should be flattened
      expect(out).toContain('![First.](./a.png)')
      expect(out).toContain('![Second.](./b.png)')
      expect(out).toContain('First.')
      expect(out).toContain('Second.')
      expect(out).not.toContain('<div id="first">')
      expect(out).not.toContain('<div id="second">')
    })

    it('artifact block adjacent to other content keeps surrounding content and ORDER intact', () => {
      const adjacentContent = `---
title: T
summary: S
status: current
---

Before artifact.

\`\`\`artifact {fallback="./middle.png", summary="Middle block."}
<div id="interactive"></div>
\`\`\`

After artifact.
`
      const out = emitMarkdown(doc(adjacentContent))
      // Check order: before should come first
      const beforeIdx = out.indexOf('Before artifact')
      const imageIdx = out.indexOf('![Middle block.]')
      const afterIdx = out.indexOf('After artifact')
      expect(beforeIdx).toBeLessThan(imageIdx)
      expect(imageIdx).toBeLessThan(afterIdx)
      // All content present
      expect(out).toContain('Before artifact')
      expect(out).toContain('![Middle block.](./middle.png)')
      expect(out).toContain('Middle block.')
      expect(out).toContain('After artifact')
    })

    it('flattened output places the image and the summary in a sensible order', () => {
      const out = emitMarkdown(doc())
      // Find the positions of image and summary
      const imageIdx = out.indexOf('![An interactive settlement explorer.]')
      const summaryTextIdx = out.indexOf('An interactive settlement explorer.')
      // Image should come before the summary text
      expect(imageIdx).toBeLessThan(summaryTextIdx)
      expect(imageIdx).toBeGreaterThanOrEqual(0)
      expect(summaryTextIdx).toBeGreaterThanOrEqual(0)
    })

    it('artifact block missing fallback throws with location info', () => {
      const missingFallback = `---
title: T
summary: S
status: current
---

\`\`\`artifact {summary="No fallback here."}
<div></div>
\`\`\`
`
      expect(() => emitMarkdown(doc(missingFallback))).toThrow(/fallback/)
      expect(() => emitMarkdown(doc(missingFallback))).toThrow(/doc\.md/)
    })

    it('artifact block missing summary throws with location info', () => {
      const missingSummary = `---
title: T
summary: S
status: current
---

\`\`\`artifact {fallback="./img.png"}
<div></div>
\`\`\`
`
      expect(() => emitMarkdown(doc(missingSummary))).toThrow(/summary/)
      expect(() => emitMarkdown(doc(missingSummary))).toThrow(/doc\.md/)
    })

    it('does not MUTATE the input Doc - tree is unchanged after emitMarkdown', () => {
      const input = doc()
      // Snapshot the input tree BEFORE the call, using a fixture WITH artifact blocks (the only nodes rewritten)
      const treeSnapshot = JSON.stringify(input.tree)
      // Call the emitter
      emitMarkdown(input)
      // Assert doc.tree still equals the snapshot — this proves no mutation occurred
      // Without structuredClone, the first call would have flattened artifacts in place,
      // so this assertion would fail if cloning was removed
      expect(JSON.stringify(input.tree)).toBe(treeSnapshot)
    })

    it('preserves inline code, links, and other inline formatting', () => {
      const withInline = `---
title: T
summary: S
status: current
---

Text with \`code\`, [link](https://example.com), and **bold**.

\`\`\`artifact {fallback="./test.png", summary="Test."}
<div></div>
\`\`\`

More text.
`
      const out = emitMarkdown(doc(withInline))
      expect(out).toContain('`code`')
      expect(out).toContain('[link](https://example.com)')
      expect(out).toContain('**bold**')
      expect(out).toContain('More text')
    })


    it('preserves lists and nested structures', () => {
      const withLists = `---
title: T
summary: S
status: current
---

- Item 1
- Item 2
  - Nested 2a
  - Nested 2b

1. First
2. Second

\`\`\`artifact {fallback="./list.png", summary="List diagram."}
<div></div>
\`\`\`

More.
`
      const out = emitMarkdown(doc(withLists))
      // remark-stringify uses * for lists, both - and * are valid markdown
      expect(out).toMatch(/[*-]\s+Item 1/)
      expect(out).toMatch(/[*-]\s+Item 2/)
      expect(out).toContain('Nested 2a')
      expect(out).toContain('1. First')
      expect(out).toContain('2. Second')
      expect(out).toContain('![List diagram.](./list.png)')
    })

    it('renders an archify block as the summary plus a relative link to the IR JSON', () => {
      const withArchify = `---
title: T
summary: S
status: current
---

Intro.

\`\`\`archify {type=workflow, src=./diagrams/tool-call.workflow.json, summary="How a tool call flows through the policy gate."}
\`\`\`

Outro.
`
      const out = emitMarkdown(doc(withArchify))
      expect(out).toContain('How a tool call flows through the policy gate.')
      expect(out).toContain('./diagrams/tool-call.workflow.json')
      // Never a rendered picture — the point is the typed IR link, not an image.
      expect(out).not.toContain('![')
    })

    it('MULTIPLE archify blocks are each flattened to their own summary and link', () => {
      const withArchify = `---
title: T
summary: S
status: current
---

\`\`\`archify {type=architecture, src=./diagrams/a.json, summary="First diagram summary."}
\`\`\`

\`\`\`archify {type=sequence, src=./diagrams/b.json, summary="Second diagram summary."}
\`\`\`
`
      const out = emitMarkdown(doc(withArchify))
      expect(out).toContain('First diagram summary.')
      expect(out).toContain('./diagrams/a.json')
      expect(out).toContain('Second diagram summary.')
      expect(out).toContain('./diagrams/b.json')
    })

    it('archify block with an invalid type throws with location info', () => {
      const badType = `---
title: T
summary: S
status: current
---

\`\`\`archify {type=bogus, src=./d.json, summary="Bad."}
\`\`\`
`
      expect(() => emitMarkdown(doc(badType))).toThrow(/type/)
      expect(() => emitMarkdown(doc(badType))).toThrow(/doc\.md/)
    })

    it('archify block missing summary throws with location info', () => {
      const missingSummary = `---
title: T
summary: S
status: current
---

\`\`\`archify {type=workflow, src=./d.json}
\`\`\`
`
      expect(() => emitMarkdown(doc(missingSummary))).toThrow(/summary/)
      expect(() => emitMarkdown(doc(missingSummary))).toThrow(/doc\.md/)
    })

    it('does not MUTATE the input Doc when an archify block is present', () => {
      // Snapshot the INPUT TREE before the call and assert it unchanged after —
      // never compare two successive outputs, which passes even if the
      // emitter mutates in place on both calls.
      const withArchify = `---
title: T
summary: S
status: current
---

\`\`\`archify {type=workflow, src=./d.json, summary="A diagram."}
\`\`\`
`
      const input = doc(withArchify)
      const treeSnapshot = JSON.stringify(input.tree)
      emitMarkdown(input)
      expect(JSON.stringify(input.tree)).toBe(treeSnapshot)
    })
  })
})
