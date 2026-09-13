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
  /**
   * `internalUrl`/`clientUrl` are the deployed addresses of the two Vercel
   * projects (see the M3 plan). Either or both may be absent — most trees
   * won't have deployed yet — in which case the site keeps working with
   * relative links; nothing here is mandatory.
   */
  site?: { host: 'vercel'; internalUrl?: string; clientUrl?: string }
  /**
   * Which Vercel project each audience deploys to (M3 Task 2) — `contrail deploy` compares this
   * against the project actually linked in `.vercel/project.json` before every deploy, so an
   * internal build can never reach the client's project (or vice versa) over a mistyped flag.
   */
  vercel?: { internalProject?: string; clientProject?: string }
  /** Archify CLI location. When `bin` is absent, `archify` is resolved from PATH. */
  archify?: { bin?: string }
  /** Google Sheets service-account credentials. `GOOGLE_APPLICATION_CREDENTIALS` takes precedence
   * over `credentialsPath` when both are set — see `src/sheets/client.ts:credentialsPathFor`. */
  sheets?: { credentialsPath?: string }
  /**
   * Where a self-hosted deploy sends the build. Two targets, and the difference between them is
   * who can read the result:
   *
   * - `plane` uploads to the Plane instance itself, which serves the site behind **its own
   *   per-project membership check** (`docs/plane-docs-api-spec.md`). Preferred: a person on one
   *   project cannot read another project's documents.
   * - `railway` writes to a volume served by Caddy, gated by "is this visitor logged into Plane" —
   *   which is all-or-nothing across every project.
   *
   * See the note on `DeployTransport` in `src/deploy/transport.ts` for why the transport is
   * pluggable rather than hard-coded.
   */
  selfhost?: SelfhostPlane | SelfhostRailway
}

export interface SelfhostPlane {
  target: 'plane'
  /** The Plane project whose Docs tab serves this build. Access follows membership of it.
   * `plane.baseUrl` and `plane.workspace` supply the rest of the address. */
  projectId: string
}

export interface SelfhostRailway {
  target: 'railway'
  volume: string
  service?: string
  /** Per-project subdirectory. Must match `^[a-z0-9][a-z0-9-]*$` — it becomes a path segment,
   * so it must not be able to escape via `..` or a leading `/`. */
  slug: string
  internalPath: string
  clientPath: string
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
