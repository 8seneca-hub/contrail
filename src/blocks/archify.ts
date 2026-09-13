import { parseAttrs } from './attrs.js'

export type ArchifyType = 'architecture' | 'workflow' | 'sequence' | 'dataflow' | 'lifecycle'

const ARCHIFY_TYPES: ArchifyType[] = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']

export interface ArchifyMeta {
  type: ArchifyType
  /** Path to the IR JSON file, relative to the document. */
  src: string
  /** Prose describing what the diagram shows. */
  summary: string
}

export class ArchifyBlockError extends Error {}

function isArchifyType(value: string): value is ArchifyType {
  return (ARCHIFY_TYPES as string[]).includes(value)
}

export function parseArchifyMeta(meta: string | null | undefined, where: string): ArchifyMeta {
  const attrs = parseAttrs(meta ?? '')

  const type = attrs.type
  if (!type || !isArchifyType(type)) {
    throw new ArchifyBlockError(
      `${where}: archify block has an invalid \`type\` (${type ? `"${type}"` : 'missing'}). ` +
        `Must be one of: ${ARCHIFY_TYPES.join(', ')}.`,
    )
  }

  if (!attrs.src) {
    throw new ArchifyBlockError(
      `${where}: archify block is missing \`src\`. Every archify block must point at the IR ` +
        'JSON file that contains the diagram.',
    )
  }

  if (!attrs.summary) {
    throw new ArchifyBlockError(
      `${where}: archify block is missing \`summary\`. Without it, an agent reading the ` +
        'Markdown has no idea what this diagram shows.',
    )
  }

  return { type, src: attrs.src, summary: attrs.summary }
}
