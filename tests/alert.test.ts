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
  it('recognises a NOTE alert', () => {
    const alert = matchAlert(firstBlockquote('> [!NOTE]\n> Body text.\n'))
    expect(alert?.kind).toBe('NOTE')
    expect(alert?.background).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('recognises a WARNING alert with a different background', () => {
    const note = matchAlert(firstBlockquote('> [!NOTE]\n> a\n'))
    const warn = matchAlert(firstBlockquote('> [!WARNING]\n> a\n'))
    expect(warn?.kind).toBe('WARNING')
    expect(warn?.background).not.toBe(note?.background)
  })

  it('returns null for an ordinary blockquote', () => {
    expect(matchAlert(firstBlockquote('> just a quote\n'))).toBeNull()
  })

  it('removes the marker line from the quote body', () => {
    const quote = firstBlockquote('> [!NOTE]\n> Body text.\n')
    stripAlertMarker(quote)
    const text = JSON.stringify(quote)
    expect(text).not.toContain('[!NOTE]')
    expect(text).toContain('Body text.')
  })
})
