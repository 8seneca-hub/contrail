import { parseAttrs } from './attrs.js'

export interface SheetMeta {
  /** Spreadsheet id (the long id segment of the Google Sheets URL). */
  id: string
  /** A1 notation range, e.g. `Estimate!A1:E40`. */
  range: string
  /** Prose describing what the range contains. */
  summary: string
}

export class SheetBlockError extends Error {}

export function parseSheetMeta(meta: string | null | undefined, where: string): SheetMeta {
  const attrs = parseAttrs(meta ?? '')

  if (!attrs.id) {
    throw new SheetBlockError(
      `${where}: sheet block is missing \`id\`. Every sheet block must name the spreadsheet it reads from.`,
    )
  }
  if (!attrs.range) {
    throw new SheetBlockError(
      `${where}: sheet block is missing \`range\`. Without an A1-notation range there is nothing to read.`,
    )
  }
  if (!attrs.summary) {
    throw new SheetBlockError(
      `${where}: sheet block is missing \`summary\`. Without it, an agent reading the Markdown has no ` +
        'idea what this range contains.',
    )
  }

  return { id: attrs.id, range: attrs.range, summary: attrs.summary }
}
