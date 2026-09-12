import type { Root } from 'mdast'

export type DocStatus = 'draft' | 'review' | 'current' | 'stale'

export interface Frontmatter {
  title: string
  summary: string
  status: DocStatus
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
}

export interface Config {
  /** Directory containing the config file. All doc globs resolve against it. */
  root: string
  plane: { baseUrl: string; workspace: string; collection?: string }
  repos: Record<string, string>
  docs: string[]
  site?: { host: 'vercel' }
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
