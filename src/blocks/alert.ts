import type { Blockquote, Paragraph, Text } from 'mdast'

export type AlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

export interface Alert {
  kind: AlertKind
  /** Plane callout `data-background`. */
  background: string
  /** Plane callout `data-emoji-unicode`: a decimal codepoint, as Plane expects. */
  emojiUnicode: string
  label: string
}

const ALERTS: Record<AlertKind, Omit<Alert, 'kind'>> = {
  NOTE: { background: '#eff6ff', emojiUnicode: '128161', label: 'Note' },
  TIP: { background: '#ecfdf5', emojiUnicode: '128161', label: 'Tip' },
  IMPORTANT: { background: '#eef2ff', emojiUnicode: '10071', label: 'Important' },
  WARNING: { background: '#fffbeb', emojiUnicode: '9888', label: 'Warning' },
  CAUTION: { background: '#fef2f2', emojiUnicode: '9940', label: 'Caution' },
}

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/

function firstText(node: Blockquote): Text | null {
  const paragraph = node.children[0]
  if (!paragraph || paragraph.type !== 'paragraph') return null
  const text = (paragraph as Paragraph).children[0]
  return text && text.type === 'text' ? (text as Text) : null
}

export function matchAlert(node: Blockquote): Alert | null {
  const text = firstText(node)
  const match = text?.value.match(MARKER)
  if (!match) return null
  const kind = match[1] as AlertKind
  return { kind, ...ALERTS[kind] }
}

/** Removes the `[!KIND]` marker, and the now-empty first line, from the quote. */
export function stripAlertMarker(node: Blockquote): void {
  const text = firstText(node)
  if (!text) return
  text.value = text.value.replace(MARKER, '').replace(/^\n+/, '')
  const paragraph = node.children[0] as Paragraph
  if (text.value === '' && paragraph.children.length === 1) {
    node.children.shift()
  }
}
