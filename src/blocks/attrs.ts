/**
 * Shared `key="value"` attribute-string parser used by every fenced-code-block
 * meta line (artifact, archify, ...). Handles single/double quotes and
 * backslash-escaped quotes within a value.
 */

// Value is a double-quoted string, a single-quoted string, or (for values with
// no special characters, e.g. `type=workflow`) a bare unquoted token.
const ATTR = /(\w+)\s*=\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s,}]+))/g

function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

export function parseAttrs(meta: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of meta.matchAll(ATTR)) {
    const doubleQuoted = match[3]
    const singleQuoted = match[4]
    const bare = match[5]
    const raw = doubleQuoted ?? singleQuoted ?? bare ?? ''
    out[match[1]!] = unescape(raw)
  }
  return out
}
