import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseDoc } from '../src/parse.js'
import { hashContent } from '../src/lock.js'
import { MAX_HTML_BYTES, publishDocs, type PublishOptions } from '../src/plane/publish.js'
import type { PlaneApi } from '../src/plane/client.js'
import type { Config, Doc, Lock } from '../src/types.js'

const DOC = `---
title: Settlement flow
summary: S
status: current
---

Intro.

\`\`\`mermaid
graph TD; A-->B;
\`\`\`
`

function fixture(body = DOC, name = 'doc.md') {
  const root = mkdtempSync(join(tmpdir(), 'contrail-publish-'))
  writeFileSync(join(root, name), body)
  return { root, doc: parseDoc(join(root, name), root) }
}

const config: Config = {
  root: '/tmp',
  plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
  repos: {},
  docs: ['./*.md'],
}

const mmdc = vi.fn(async (_input: string, output: string) => writeFileSync(output, 'stub-png-bytes'))

/**
 * Ruling 1: the brief's fake was stateless (`getPage` always returned a fixed
 * body), so a second publish never saw what the first one wrote and the
 * overwrite guard always fired. This fake is STATEFUL: `updatePage` and
 * `createPage` record the body they were given in `pages`, and `getPage`
 * returns whatever is currently recorded for that page id. That lets a test
 * reuse one client across two `publishDocs` calls and exercise the real
 * create -> read-back -> guard round trip instead of a fiction.
 */
function fakeClient(overrides: Partial<PlaneApi> = {}): PlaneApi & { calls: string[]; pages: Map<string, string> } {
  const calls: string[] = []
  const pages = new Map<string, string>()
  let nextPageId = 1
  let nextAssetId = 1

  const base: PlaneApi = {
    createPage: async (input) => {
      calls.push('createPage')
      const id = `page-${nextPageId++}`
      pages.set(id, input.description_html)
      return { id, parentLinkPending: false }
    },
    getPage: async (pageId) => {
      calls.push('getPage')
      return {
        id: pageId,
        name: 'Settlement flow',
        description_html: pages.get(pageId) ?? '<p>remote</p>',
        updated_at: '',
      }
    },
    updatePage: async (pageId, input) => {
      calls.push('updatePage')
      pages.set(pageId, input.description_html)
    },
    archivePage: async () => void calls.push('archivePage'),
    createAssetUpload: async () => {
      calls.push('createAssetUpload')
      return { asset_id: `asset-${nextAssetId++}`, upload_data: { url: 'https://s3.test', fields: {} } }
    },
    uploadAssetBytes: async () => void calls.push('uploadAssetBytes'),
    confirmAttachment: async () => void calls.push('confirmAttachment'),
  }
  return { ...base, ...overrides, calls, pages }
}

function run(args: { doc: Doc; root: string; client: PlaneApi; lock: Lock; options?: PublishOptions }) {
  return publishDocs({
    config,
    docs: [args.doc],
    client: args.client,
    lock: args.lock,
    cacheDir: join(args.root, '.cache'),
    options: { ...args.options, mmdc },
  })
}

describe('publishDocs', () => {
  it('creates the page, uploads assets, then replaces the body', async () => {
    const { root, doc } = fixture()
    const client = fakeClient()
    const lock: Lock = { version: 1, docs: {} }

    const result = await run({ doc, root, client, lock })

    expect(result.created).toEqual(['doc.md'])
    expect(client.calls.indexOf('createPage')).toBeLessThan(client.calls.indexOf('createAssetUpload'))
    expect(client.calls.indexOf('uploadAssetBytes')).toBeLessThan(client.calls.indexOf('updatePage'))
    expect(client.calls).toContain('confirmAttachment')
    expect(lock.docs['doc.md']?.pageId).toBe('page-1')
    // No lock entry yet: the overwrite guard must not even ask about the page.
    expect(client.calls).not.toContain('getPage')
  })

  it('performs no writes on a second publish of unchanged content', async () => {
    const { root, doc } = fixture()
    const lock: Lock = { version: 1, docs: {} }
    const client = fakeClient()

    await run({ doc, root, client, lock })
    const stored = structuredClone(lock.docs['doc.md']!)
    const callsAfterFirst = client.calls.length

    // Reuse the SAME stateful client: its `pages` map still holds exactly
    // what the first publish wrote, so the guard's remote-hash check passes
    // for real and the content hash matches, and nothing should happen.
    const result = await run({ doc, root, client, lock })
    const secondCalls = client.calls.slice(callsAfterFirst)

    expect(result.blocked.concat(result.updated)).toEqual([])
    expect(result.skipped).toEqual(['doc.md'])
    expect(secondCalls).not.toContain('updatePage')
    expect(secondCalls).not.toContain('createAssetUpload')
    expect(lock.docs['doc.md']).toEqual(stored)
  })

  it('refuses to overwrite a page edited in Plane since the last publish', async () => {
    const { root, doc } = fixture()
    const lock: Lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', remoteHash: 'what-we-wrote', assets: {} } },
    }
    const client = fakeClient()

    const result = await run({ doc, root, client, lock })

    expect(result.blocked).toEqual(['doc.md'])
    expect(client.calls).not.toContain('updatePage')
  })

  it('overwrites the human edit when force is set, and writes the correct body', async () => {
    const { root, doc } = fixture()
    const lock: Lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', remoteHash: 'what-we-wrote', assets: {} } },
    }
    const client = fakeClient()

    const result = await run({ doc, root, client, lock, options: { force: true } })

    expect(result.updated).toEqual(['doc.md'])
    expect(client.calls).toContain('updatePage')

    const after = await client.getPage(lock.docs['doc.md']!.pageId)
    expect(hashContent([after.description_html])).toBe(lock.docs['doc.md']!.remoteHash)
    expect(after.description_html).toContain('Intro')
  })

  it('writes nothing during a dry run and leaves the lock unmodified', async () => {
    const { root, doc } = fixture()
    const client = fakeClient()
    const lock: Lock = { version: 1, docs: {} }
    const lockSnapshot = structuredClone(lock)

    const result = await run({ doc, root, client, lock, options: { dryRun: true } })

    expect(result.created).toEqual(['doc.md'])
    expect(client.calls).not.toContain('createPage')
    expect(client.calls).not.toContain('updatePage')
    expect(client.calls).toEqual([])
    expect(lock).toEqual(lockSnapshot)
  })

  it('rejects a document whose HTML exceeds the Plane payload ceiling', async () => {
    const big = `---\ntitle: T\nsummary: S\nstatus: current\n---\n\n${'x'.repeat(MAX_HTML_BYTES + 1)}\n`
    const { root, doc } = fixture(big)
    await expect(run({ doc, root, client: fakeClient(), lock: { version: 1, docs: {} } })).rejects.toThrow(/10 MB/)
    await expect(run({ doc, root, client: fakeClient(), lock: { version: 1, docs: {} } })).rejects.toThrow(/doc\.md/)
  })

  it('archives the page of a document that no longer exists', async () => {
    const { root } = fixture()
    const client = fakeClient()
    const lock: Lock = {
      version: 1,
      docs: { 'gone.md': { pageId: 'page-9', contentHash: 'c', remoteHash: 'r', assets: {} } },
    }

    const result = await publishDocs({ config, docs: [], client, lock, cacheDir: join(root, '.cache') })

    expect(result.archived).toEqual(['gone.md'])
    expect(client.calls).toContain('archivePage')
    expect(lock.docs['gone.md']?.archived).toBe(true)
  })

  it('does not re-archive a document whose lock entry is already archived', async () => {
    const { root } = fixture()
    const client = fakeClient()
    const lock: Lock = {
      version: 1,
      docs: { 'gone.md': { pageId: 'page-9', contentHash: 'c', remoteHash: 'r', assets: {}, archived: true } },
    }

    const result = await publishDocs({ config, docs: [], client, lock, cacheDir: join(root, '.cache') })

    expect(result.archived).toEqual([])
    expect(client.calls).not.toContain('archivePage')
  })

  it('creates a new page for a re-added document whose lock entry was archived', async () => {
    const { root, doc } = fixture()
    const lock: Lock = {
      version: 1,
      docs: {
        'doc.md': { pageId: 'page-old', contentHash: 'stale', remoteHash: 'stale-remote', assets: {}, archived: true },
      },
    }
    const client = fakeClient()

    const result = await run({ doc, root, client, lock })

    expect(result.created).toEqual(['doc.md'])
    expect(client.calls).toContain('createPage')
    // The archived page must never be read back through the overwrite guard.
    expect(client.calls).not.toContain('getPage')
    expect(lock.docs['doc.md']?.pageId).not.toBe('page-old')
    expect(lock.docs['doc.md']?.archived).toBeUndefined()
  })

  it('does not corrupt the lock when asset collection throws', async () => {
    const badDoc = `---
title: T
summary: S
status: current
---

\`\`\`artifact {fallback="./missing.png", summary="oops"}
<div id="x"></div>
\`\`\`
`
    const { root, doc } = fixture(badDoc)
    const lock: Lock = { version: 1, docs: {} }

    await expect(run({ doc, root, client: fakeClient(), lock })).rejects.toThrow(/fallback image not found/)

    expect(lock.docs['doc.md']).toBeUndefined()
    expect(Object.keys(lock.docs)).toEqual([])
  })

  it('dedupes a diagram embedded twice into a single asset upload', async () => {
    const dupDoc = `---
title: T
summary: S
status: current
---

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

Some text between.

\`\`\`mermaid
graph TD; A-->B;
\`\`\`
`
    const { root, doc } = fixture(dupDoc)
    const client = fakeClient()
    const lock: Lock = { version: 1, docs: {} }

    const result = await run({ doc, root, client, lock })

    expect(result.created).toEqual(['doc.md'])
    expect(client.calls.filter((c) => c === 'createAssetUpload')).toHaveLength(1)
    expect(client.calls.filter((c) => c === 'confirmAttachment')).toHaveLength(1)
    // emitPlane must still resolve BOTH occurrences from the single id -> uuid
    // mapping, or it would have thrown "no uploaded asset for diagram ...".
    expect(client.calls).toContain('updatePage')
    expect(Object.keys(lock.docs['doc.md']!.assets)).toHaveLength(1)
  })

  it('never runs more than 4 publishes concurrently', async () => {
    const docs: Doc[] = []
    const roots: string[] = []
    for (let i = 0; i < 8; i++) {
      const { root, doc } = fixture(DOC, `doc-${i}.md`)
      docs.push(doc)
      roots.push(root)
    }
    const cacheDir = join(mkdtempSync(join(tmpdir(), 'contrail-publish-cache-')), '.cache')

    let active = 0
    let peak = 0
    const track =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 10))
        try {
          return await fn(...a)
        } finally {
          active--
        }
      }

    const inner = fakeClient()
    const client: PlaneApi & { calls: string[] } = {
      ...inner,
      createPage: track(inner.createPage),
      getPage: track(inner.getPage),
      updatePage: track(inner.updatePage),
      archivePage: track(inner.archivePage),
      createAssetUpload: track(inner.createAssetUpload),
      uploadAssetBytes: track(inner.uploadAssetBytes),
      confirmAttachment: track(inner.confirmAttachment),
      calls: inner.calls,
    }

    const lock: Lock = { version: 1, docs: {} }
    const result = await publishDocs({ config, docs, client, lock, cacheDir, options: { mmdc } })

    expect(result.created).toHaveLength(8)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })
})
