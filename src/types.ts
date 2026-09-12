import type { Root } from 'mdast'
import type { DocKind, Section } from './doc-kinds.js'

export type DocStatus = 'draft' | 'review' | 'current' | 'stale'

/** Diátaxis document shape — how the writing is structured. Optional:
 * retrofitting it across an existing docs tree must not break a build.
 * Absent means `mixed-mode` does not fire. Kept separate from `docKind`
 * (below), which answers a different question: what role the document
 * plays in the project. A PRD is `docKind: 'prd'`, `kind: 'reference'`. */
export type DiataxisKind = 'tutorial' | 'how-to' | 'reference' | 'explanation'

export type Audience = 'internal' | 'client'

export interface Frontmatter {
  title: string
  summary: string
  status: DocStatus
  kind?: DiataxisKind
  /**
   * The client-visibility gate. This is a SAFETY property, not a
   * convenience: it defaults to `'internal'` when absent, because a
   * document nobody has classified must never be publishable to a client.
   * Only an explicit `audience: client` opts a document in. `parseDoc`
   * always populates this — it is never left `undefined` on a parsed Doc.
   */
  audience: Audience
  section?: Section
  docKind?: DocKind
  owner?: string
  /** ISO date; feeds a staleness rule later. */
  reviewedOn?: string
  /** Provenance — which client artefact this document's content came from. */
  sources?: string[]
  repos?: string[]
  tags?: string[]
  decisions?: number[]
  watch?: string[]
  plane?: { collection?: string; parent?: string }
}

export interface Doc {
  /** Absolute path on disk. */
  absPath: string
  /** Path relative to the workspace root, POSIX separators. The lockfile key. */
  key: string
  frontmatter: Frontmatter
  tree: Root
  /** Markdown body with the frontmatter removed. */
  body: string
  /**
   * Whether `audience` was written explicitly in this document's
   * frontmatter, as opposed to defaulted to `'internal'` by `parseDoc`.
   * Drives `unclassified-money-doc`: a money document silently relying on
   * the safe default must be loud, not quiet.
   */
  audienceExplicit: boolean
}

export interface Config {
  /** Directory containing the config file. All doc globs resolve against it. */
  root: string
  plane: { baseUrl: string; workspace: string; collection?: string }
  repos: Record<string, string>
  docs: string[]
  site?: { host: 'vercel' }
  /** Archify CLI location. When `bin` is absent, `archify` is resolved from PATH. */
  archify?: { bin?: string }
  /** Google Sheets service-account credentials. `GOOGLE_APPLICATION_CREDENTIALS` takes precedence
   * over `credentialsPath` when both are set — see `src/sheets/client.ts:credentialsPathFor`. */
  sheets?: { credentialsPath?: string }
}

export interface RenderedDiagram {
  hash: string
  pngPath: string
  svgPath: string
}

export interface LockEntry {
  pageId: string
  /** Hash of the emitted Plane HTML we last wrote. */
  contentHash: string
  /** Hash of the page body as Plane reported it after our last write. */
  remoteHash: string
  /** Diagram content hash to Plane asset id. */
  assets: Record<string, string>
  archived?: boolean
}

export interface Lock {
  version: 1
  docs: Record<string, LockEntry>
}
