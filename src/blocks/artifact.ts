export interface ArtifactMeta {
  /** Path to a static image, relative to the document. */
  fallback: string
  /** Prose describing what the interactive block shows. */
  summary: string
}

export class ArtifactBlockError extends Error {}

const ATTR = /(\w+)\s*=\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g

function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

function parseAttrs(meta: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of meta.matchAll(ATTR)) {
    const doubleQuoted = match[3]
    const singleQuoted = match[4]
    const raw = doubleQuoted ?? singleQuoted ?? ''
    out[match[1]!] = unescape(raw)
  }
  return out
}

export function parseArtifactMeta(meta: string | null | undefined, where: string): ArtifactMeta {
  const attrs = parseAttrs(meta ?? '')
  if (!attrs.fallback) {
    throw new ArtifactBlockError(
      `${where}: artifact block is missing \`fallback\`. Every artifact block must declare a ` +
        'static image, so readers in Plane see the same information as readers of the site.',
    )
  }
  if (!attrs.summary) {
    throw new ArtifactBlockError(
      `${where}: artifact block is missing \`summary\`. Without it, an agent reading the ` +
        'Markdown has no idea what this block contains.',
    )
  }
  return { fallback: attrs.fallback, summary: attrs.summary }
}
