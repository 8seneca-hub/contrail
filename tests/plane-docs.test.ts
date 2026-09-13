import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { collectDocsFiles, createPlaneDocsTransport } from '../src/deploy/plane-docs.js'

function buildDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'contrail-plane-docs-'))
  writeFileSync(join(dir, 'index.html'), '<h1>Index</h1>')
  writeFileSync(join(dir, 'site.css'), 'body{}')
  mkdirSync(join(dir, '04-technical'), { recursive: true })
  writeFileSync(join(dir, '04-technical', 'prd.html'), '<h1>PRD</h1>')
  return dir
}

interface Call {
  url: string
  body: unknown
}

/** A Plane that presigns every file it is offered. `calls` records the API requests in order, which
 * is what most of these tests are really asserting about. */
function fakePlane(options: { presignOnly?: string[]; uploadStatus?: number } = {}) {
  const calls: Call[] = []
  const uploaded: string[] = []

  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)

    if (url.includes('/docs/uploads/')) {
      const body = JSON.parse(String(init?.body)) as { files: Array<{ path: string }> }
      calls.push({ url, body })
      const paths = options.presignOnly ?? body.files.map((file) => file.path)
      return new Response(
        JSON.stringify({
          uploads: paths.map((path) => ({
            path,
            upload_data: { url: `https://minio.test/put/${path}`, fields: { key: path } },
          })),
        }),
        { status: 200 },
      )
    }

    if (url.startsWith('https://minio.test/')) {
      uploaded.push(url.replace('https://minio.test/put/', ''))
      const status = options.uploadStatus ?? 204
      return new Response(status === 204 ? null : '', { status })
    }

    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response('{}', { status: 200 })
  })

  return { fetchFn: fetchFn as unknown as typeof fetch, calls, uploaded }
}

function transportFor(fetchFn: typeof fetch) {
  return createPlaneDocsTransport({
    baseUrl: 'https://projects.8seneca.com/',
    workspace: 'acme',
    projectId: 'proj-123',
    apiKey: 'key-abc',
    fetchFn,
    buildId: 'build-1',
  })
}

describe('collectDocsFiles', () => {
  it('walks recursively and reports POSIX paths, sizes and content types', () => {
    const files = collectDocsFiles(buildDir())

    expect(files.map((file) => file.path)).toEqual(['04-technical/prd.html', 'index.html', 'site.css'])
    expect(files.find((file) => file.path === 'site.css')?.type).toBe('text/css')
    expect(files.find((file) => file.path === 'index.html')?.size).toBe('<h1>Index</h1>'.length)
  })

  it('types an unknown extension as a stream rather than guessing', () => {
    const dir = buildDir()
    writeFileSync(join(dir, 'notes.xyz'), 'x')

    expect(collectDocsFiles(dir).find((file) => file.path === 'notes.xyz')?.type).toBe('application/octet-stream')
  })
})

describe('createPlaneDocsTransport', () => {
  it('sends the manifest, uploads every file, and commits last', async () => {
    const plane = fakePlane()
    const result = await transportFor(plane.fetchFn).push(buildDir(), 'internal', {})

    expect(plane.calls.map((call) => call.url)).toEqual([
      'https://projects.8seneca.com/api/v1/workspaces/acme/projects/proj-123/docs/uploads/',
      'https://projects.8seneca.com/api/v1/workspaces/acme/projects/proj-123/docs/commit/',
    ])
    expect(plane.uploaded.sort()).toEqual(['04-technical/prd.html', 'index.html', 'site.css'])
    expect(result.filesSent).toBe(3)
  })

  it('carries the audience through to both the manifest and the commit', async () => {
    const plane = fakePlane()
    await transportFor(plane.fetchFn).push(buildDir(), 'client', {})

    expect(plane.calls[0]?.body).toMatchObject({ audience: 'client', build_id: 'build-1' })
    expect(plane.calls[1]?.body).toEqual({ build_id: 'build-1', audience: 'client' })
  })

  it('authenticates the API calls but never the object-storage upload', async () => {
    const plane = fakePlane()
    await transportFor(plane.fetchFn).push(buildDir(), 'internal', {})

    const headersFor = (url: string): Record<string, string> =>
      ((plane.fetchFn as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.find(
        ([called]) => String(called) === url,
      )?.[1].headers ?? {}) as Record<string, string>

    expect(headersFor('https://projects.8seneca.com/api/v1/workspaces/acme/projects/proj-123/docs/uploads/')).toEqual({
      'X-API-Key': 'key-abc',
      'Content-Type': 'application/json',
    })
    expect(headersFor('https://minio.test/put/index.html')['X-API-Key']).toBeUndefined()
  })

  it('uploads nothing and commits nothing on a dry run', async () => {
    const plane = fakePlane()
    const result = await transportFor(plane.fetchFn).push(buildDir(), 'internal', { dryRun: true })

    expect(plane.fetchFn).not.toHaveBeenCalled()
    expect(result.filesSent).toBe(3)
    expect(result.bytes).toBeGreaterThan(0)
  })

  // The commit is what makes a build live. Both of these would otherwise publish a site with a
  // hole in it — a page whose diagram or stylesheet never arrived.
  it('refuses to commit when Plane presigns fewer files than the manifest listed', async () => {
    const plane = fakePlane({ presignOnly: ['index.html', 'site.css'] })

    await expect(transportFor(plane.fetchFn).push(buildDir(), 'internal', {})).rejects.toThrow(
      /no upload URL for 1 file\(s\), first: 04-technical\/prd\.html/,
    )
    expect(plane.calls.some((call) => call.url.includes('/commit/'))).toBe(false)
  })

  it('refuses to commit when an upload fails', async () => {
    const plane = fakePlane({ uploadStatus: 500 })

    await expect(transportFor(plane.fetchFn).push(buildDir(), 'internal', {})).rejects.toThrow(/failed with 500/)
    expect(plane.calls.some((call) => call.url.includes('/commit/'))).toBe(false)
  })
})
