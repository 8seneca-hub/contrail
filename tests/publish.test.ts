import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseDoc } from '../src/parse.js'
import { hashContent } from '../src/lock.js'
import { MAX_HTML_BYTES, publishDocs, type PublishOptions } from '../src/plane/publish.js'
import { PlaneApiError, type PlaneApi } from '../src/plane/client.js'
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

    const before = structuredClone(lock.docs['doc.md']!)
    const result = await run({ doc, root, client, lock })

    expect(result.blocked).toEqual(['doc.md'])
    expect(client.calls).not.toContain('updatePage')
    // Blocking must not touch the lock at all.
    expect(lock.docs['doc.md']).toEqual(before)
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

  it('does not archive a document present in knownKeys but filtered out of docs', async () => {
    // Regression test for the --only archive bug: a filtered `docs` array must
    // never be mistaken for the full set of documents on disk. `knownKeys`
    // carries the true full set; anything present there is not "missing" and
    // must survive even though it isn't in `docs` for this run.
    const { root } = fixture()
    const client = fakeClient()
    const lock: Lock = {
      version: 1,
      docs: { 'other.md': { pageId: 'page-9', contentHash: 'c', remoteHash: 'r', assets: {} } },
    }

    const result = await publishDocs({
      config,
      docs: [],
      client,
      lock,
      cacheDir: join(root, '.cache'),
      knownKeys: ['other.md'],
    })

    expect(result.archived).toEqual([])
    expect(client.calls).not.toContain('archivePage')
    expect(lock.docs['other.md']?.archived).toBeUndefined()
  })

  it('falls back to docs as the full set when knownKeys is omitted (unchanged prior behavior)', async () => {
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

  it('reports a would-be archive during a dry run without mutating the lock or calling archivePage', async () => {
    const { root } = fixture()
    const client = fakeClient()
    const lock: Lock = {
      version: 1,
      docs: { 'gone.md': { pageId: 'page-9', contentHash: 'c', remoteHash: 'r', assets: {} } },
    }
    const before = structuredClone(lock.docs['gone.md']!)

    const result = await publishDocs({
      config,
      docs: [],
      client,
      lock,
      cacheDir: join(root, '.cache'),
      options: { dryRun: true },
    })

    expect(result.archived).toEqual(['gone.md'])
    expect(client.calls).not.toContain('archivePage')
    // A dry run must not set `archived: true`, or the next real run would see
    // it and skip archiving forever, having never actually archived the page.
    expect(lock.docs['gone.md']).toEqual(before)
    expect(lock.docs['gone.md']?.archived).toBeUndefined()
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

  it('blocks when remoteHash is empty: cannot prove the remote body is what we wrote', async () => {
    const { root, doc } = fixture()
    const lock: Lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', remoteHash: '', assets: {} } },
    }
    const before = structuredClone(lock.docs['doc.md']!)
    const client = fakeClient()

    const result = await run({ doc, root, client, lock })

    expect(result.blocked).toEqual(['doc.md'])
    expect(client.calls).not.toContain('updatePage')
    expect(lock.docs['doc.md']).toEqual(before)
  })

  it('blocks when remoteHash is absent entirely (hand-edited or migrated lockfile)', async () => {
    const { root, doc } = fixture()
    // Deliberately malformed: `loadLock` does an unvalidated JSON.parse, so a
    // hand-edited lockfile can easily produce an entry missing this field.
    const lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', assets: {} } },
    } as unknown as Lock
    const client = fakeClient()

    const result = await run({ doc, root, client, lock })

    expect(result.blocked).toEqual(['doc.md'])
    expect(client.calls).not.toContain('updatePage')
  })

  it('force still overrides the guard when remoteHash is empty or absent', async () => {
    const { root, doc } = fixture()
    const emptyLock: Lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', remoteHash: '', assets: {} } },
    }
    const emptyResult = await run({ doc, root, client: fakeClient(), lock: emptyLock, options: { force: true } })
    expect(emptyResult.updated).toEqual(['doc.md'])

    const { root: root2, doc: doc2 } = fixture()
    const absentLock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', assets: {} } },
    } as unknown as Lock
    const absentResult = await run({ doc: doc2, root: root2, client: fakeClient(), lock: absentLock, options: { force: true } })
    expect(absentResult.updated).toEqual(['doc.md'])
  })

  it('treats a 404 from getPage as a deleted page and creates a fresh one instead of aborting', async () => {
    const { root, doc } = fixture()
    const lock: Lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-gone', contentHash: 'stale', remoteHash: 'stale-remote', assets: {} } },
    }
    const client = fakeClient({
      getPage: async () => {
        throw new PlaneApiError('page not found', 404, '')
      },
    })

    const result = await run({ doc, root, client, lock })

    expect(result.created).toEqual(['doc.md'])
    expect(client.calls).toContain('createPage')
    expect(client.calls).toContain('updatePage')
    expect(lock.docs['doc.md']?.pageId).not.toBe('page-gone')
  })

  it('propagates a non-404 error from getPage rather than swallowing it', async () => {
    const { root, doc } = fixture()
    const lock: Lock = {
      version: 1,
      docs: { 'doc.md': { pageId: 'page-1', contentHash: 'stale', remoteHash: 'stale-remote', assets: {} } },
    }
    const client = fakeClient({
      getPage: async () => {
        throw new PlaneApiError('server error', 500, '')
      },
    })

    await expect(run({ doc, root, client, lock })).rejects.toThrow(/server error/)
    expect(client.calls).not.toContain('updatePage')
  })

  it('recovers from a crash right after page creation without creating a duplicate page', async () => {
    const { root, doc } = fixture()
    const lock: Lock = { version: 1, docs: {} }
    const client = fakeClient()

    let uploadAttempts = 0
    const originalCreateAssetUpload = client.createAssetUpload
    client.createAssetUpload = async (input) => {
      uploadAttempts++
      if (uploadAttempts === 1) throw new Error('network blip during asset upload')
      return originalCreateAssetUpload(input)
    }

    await expect(run({ doc, root, client, lock })).rejects.toThrow(/network blip/)

    const provisional = lock.docs['doc.md']
    expect(provisional).toBeDefined()
    expect(provisional?.contentHash).toBe('')
    expect(client.calls.filter((c) => c === 'createPage')).toHaveLength(1)

    // The provisional remoteHash must match the actual stub body Plane is
    // holding right now, or the guard on the next run would block instead of
    // recovering.
    const remoteNow = await client.getPage(provisional!.pageId)
    expect(hashContent([remoteNow.description_html])).toBe(provisional!.remoteHash)

    const result = await run({ doc, root, client, lock })

    expect(result.blocked).toEqual([])
    expect(result.created.concat(result.updated)).toEqual(['doc.md'])
    expect(client.calls.filter((c) => c === 'createPage')).toHaveLength(1)
    expect(lock.docs['doc.md']?.pageId).toBe(provisional!.pageId)
    expect(lock.docs['doc.md']?.contentHash).not.toBe('')
  })
})
