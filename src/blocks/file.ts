import { parseAttrs } from './attrs.js'

export interface FileMeta {
  /**
   * Path to the raw file, relative to the PROJECT ROOT — the same spelling the
   * `files` glob produces, e.g. `raw/ZJEDENE_Austria_Estimation.xlsx`. Not
   * relative to the document: raw material lives outside `docs/`, so a
   * document-relative path would climb out of the tree and read badly.
   */
  src: string
  /** What this file is, for a reader deciding whether to download it. */
  summary: string
}

export class FileBlockError extends Error {}

export function parseFileMeta(meta: string | null | undefined, where: string): FileMeta {
  const attrs = parseAttrs(meta ?? '')

  if (!attrs.src) {
    throw new FileBlockError(
      `${where}: file block is missing \`src\`. Give the path to the raw file relative to the ` +
        'project root, matching a `files` glob in contrail.config.ts.',
    )
  }
  if (!attrs.summary) {
    throw new FileBlockError(
      `${where}: file block is missing \`summary\`. Without it a reader has only a filename to ` +
        'decide whether the download is worth it.',
    )
  }
  return { src: attrs.src, summary: attrs.summary }
}
