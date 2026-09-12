import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Code, Parent, Root, RootContent, Table, TableCell, TableRow } from 'mdast'
import { parseArchifyMeta } from '../blocks/archify.js'
import { parseArtifactMeta } from '../blocks/artifact.js'
import { parseSheetMeta } from '../blocks/sheet.js'
import { getSnapshot } from '../sheets/snapshot.js'
import type { Doc } from '../types.js'

/** Pads every row to the width of the widest row, so a ragged range (Google Sheets omits trailing
 * empty cells) still renders a well-formed table with a consistent column count. */
function padRows(rows: string[][]): string[][] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''))
}

function tableCell(value: string): TableCell {
  return { type: 'tableCell', children: [{ type: 'text', value }] }
}

function tableRow(cells: string[]): TableRow {
  return { type: 'tableRow', children: cells.map(tableCell) }
}

/** Builds a GFM table node from a range's values, treating the first row as the header — GFM tables
 * require one. `remark-gfm` (already used by the rest of this pipeline) stringifies it. */
function sheetTableNode(rows: string[][]): Table {
  const padded = padRows(rows)
  return {
    type: 'table',
    align: padded[0]?.map(() => null) ?? [],
    children: padded.map(tableRow),
  }
}

export function emitMarkdown(doc: Doc): string {
  const tree = structuredClone(doc.tree) as Root

  visit(tree, 'code', (node: Code, index: number | undefined, parent: Parent | undefined) => {
    if (parent === undefined || index === undefined) return
    const where = `${doc.key}:${node.position?.start.line ?? '?'}`

    if (node.lang === 'artifact') {
      const meta = parseArtifactMeta(node.meta, where)
      const replacement: RootContent[] = [
        {
          type: 'paragraph',
          children: [{ type: 'image', url: meta.fallback, alt: meta.summary }],
        },
        { type: 'paragraph', children: [{ type: 'text', value: meta.summary }] },
      ]
      parent.children.splice(index, 1, ...replacement)
      return
    }

    if (node.lang === 'archify') {
      // Agents reading the typed IR get more than a picture would give them,
      // so the archify block becomes the summary plus a link to the IR JSON
      // rather than any rendered form.
      const meta = parseArchifyMeta(node.meta, where)
      const replacement: RootContent[] = [
        { type: 'paragraph', children: [{ type: 'text', value: meta.summary }] },
        {
          type: 'paragraph',
          children: [{ type: 'link', url: meta.src, children: [{ type: 'text', value: meta.src }] }],
        },
      ]
      parent.children.splice(index, 1, ...replacement)
      return
    }

    if (node.lang === 'sheet') {
      // Agents get the numbers as a table, not a live Google Sheets link they cannot follow.
      const meta = parseSheetMeta(node.meta, where)
      const snapshot = getSnapshot(doc, meta.id, meta.range)
      if (!snapshot) {
        throw new Error(
          `${where}: no cached snapshot for spreadsheet ${meta.id} (range ${meta.range}). ` +
            'Run `contrail sheet pull` first.',
        )
      }

      const replacement: RootContent[] = [
        { type: 'paragraph', children: [{ type: 'text', value: meta.summary }] },
      ]
      if (snapshot.stale) {
        replacement.push({
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: `STALE: the live read failed; showing the cached snapshot from ${snapshot.readAt}.`,
            },
          ],
        })
      }
      replacement.push(sheetTableNode(snapshot.values))
      replacement.push({
        type: 'paragraph',
        children: [
          { type: 'text', value: `Read ${snapshot.readAt} from spreadsheet ${meta.id}, range ${meta.range}.` },
        ],
      })
      parent.children.splice(index, 1, ...replacement)
    }
  })

  return String(unified().use(remarkGfm).use(remarkStringify, { fences: true }).stringify(tree))
}
