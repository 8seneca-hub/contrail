import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import type { Blockquote } from 'mdast'
import { matchAlert, stripAlertMarker } from '../src/blocks/alert.js'

function firstBlockquote(md: string): Blockquote {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(md)
  const node = tree.children.find((c) => c.type === 'blockquote')
  if (!node) throw new Error('no blockquote in fixture')
  return node as Blockquote
}

describe('matchAlert', () => {
  it.each([
    { kind: 'NOTE', background: '#eff6ff', emojiUnicode: '128161' },
    { kind: 'TIP', background: '#ecfdf5', emojiUnicode: '128161' },
    { kind: 'IMPORTANT', background: '#eef2ff', emojiUnicode: '10071' },
    { kind: 'WARNING', background: '#fffbeb', emojiUnicode: '9888' },
    { kind: 'CAUTION', background: '#fef2f2', emojiUnicode: '9940' },
  ])('recognises $kind alert with correct attributes', ({ kind, background, emojiUnicode }) => {
    const alert = matchAlert(firstBlockquote(`> [!${kind}]\n> Body text.\n`))
    expect(alert?.kind).toBe(kind)
    expect(alert?.background).toBe(background)
    expect(alert?.emojiUnicode).toBe(emojiUnicode)
  })

  it('returns null for an ordinary blockquote', () => {
    expect(matchAlert(firstBlockquote('> just a quote\n'))).toBeNull()
  })

  it('returns null for a blockquote with a list as first child', () => {
    expect(matchAlert(firstBlockquote('> - a list item\n'))).toBeNull()
  })

  it('returns null for an empty blockquote', () => {
    expect(matchAlert(firstBlockquote('>\n'))).toBeNull()
  })
})

describe('stripAlertMarker', () => {
  it('removes the marker line from the quote body', () => {
    const quote = firstBlockquote('> [!NOTE]\n> Body text.\n')
    stripAlertMarker(quote)
    const text = JSON.stringify(quote)
    expect(text).not.toContain('[!NOTE]')
    expect(text).toContain('Body text.')
  })

  it('preserves inline text on the same line as the marker', () => {
    const quote = firstBlockquote('> [!NOTE] inline text\n')
    stripAlertMarker(quote)
    const text = JSON.stringify(quote)
    expect(text).toContain('inline text')
  })

  it('preserves body paragraph when marker is alone in its own paragraph', () => {
    const quote = firstBlockquote('> [!NOTE]\n>\n> Body paragraph.\n')
    stripAlertMarker(quote)
    const text = JSON.stringify(quote)
    expect(text).not.toContain('[!NOTE]')
    expect(text).toContain('Body paragraph.')
  })
})
