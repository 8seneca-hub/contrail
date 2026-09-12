import { describe, expect, it, vi } from 'vitest'
import { PlaneApiError, PlaneClient } from '../src/plane/client.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchFn: typeof fetch, baseUrl = 'https://plane.test') {
  return new PlaneClient({ baseUrl, workspace: 'acme', apiKey: 'k', fetchFn })
}

function callsOf(fetchFn: typeof fetch) {
  return (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
}

describe('PlaneClient', () => {
  it('creates a page and sends the API key', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'page-1' }, 201)) as unknown as typeof fetch
    const result = await client(fetchFn).createPage({ name: 'T', description_html: '<p>x</p>' })

    expect(result).toEqual({ id: 'page-1', parentLinkPending: false })
    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as { headers: Record<string, string> }).headers['X-API-Key']).toBe('k')
  })

  it('treats 202 as success with the parent link still pending', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'page-2' }, 202)) as unknown as typeof fetch
    const result = await client(fetchFn).createPage({ name: 'T', description_html: '<p>x</p>', parent_id: 'p' })
    expect(result).toEqual({ id: 'page-2', parentLinkPending: true })
  })

  it('rejects a page created with both parent_id and collection_id', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'x' }, 201)) as unknown as typeof fetch
    await expect(
      client(fetchFn).createPage({ name: 'T', description_html: '<p>x</p>', parent_id: 'a', collection_id: 'b' }),
    ).rejects.toThrow(/both/)
    // and no network call was made for the rejected combination
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('updates a page with PUT', async () => {
    const fetchFn = vi.fn(async () => json({}, 200)) as unknown as typeof fetch
    await client(fetchFn).updatePage('page-1', { name: 'T', description_html: '<p>y</p>' })
    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/page-1/')
    expect((init as RequestInit).method).toBe('PUT')
  })

  it('throws PlaneApiError carrying the status', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    await expect(client(fetchFn).getPage('page-1')).rejects.toBeInstanceOf(PlaneApiError)
    await expect(client(fetchFn).getPage('page-1')).rejects.toMatchObject({ status: 403 })
  })

  it('posts asset bytes to the presigned URL with every field and no API key', async () => {
    // Node's fetch implementation requires a null body (not '') for null-body statuses like 204.
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const upload = { asset_id: 'a1', upload_data: { url: 'https://s3.test/bucket', fields: { key: 'k1', policy: 'p' } } }
    await client(fetchFn).uploadAssetBytes(upload, new Uint8Array([1, 2, 3]), 'image/png', 'flow.png')

    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://s3.test/bucket')
    const form = (init as RequestInit).body as FormData
    expect(form.get('key')).toBe('k1')
    expect(form.get('policy')).toBe('p')
    expect(form.get('file')).toBeInstanceOf(Blob)
    expect((init as RequestInit).headers).toBeUndefined()
  })

  it('confirms an attachment with PATCH and is_uploaded', async () => {
    const fetchFn = vi.fn(async () => json({}, 200)) as unknown as typeof fetch
    await client(fetchFn).confirmAttachment('page-1', 'asset-1')
    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/page-1/attachments/asset-1/')
    expect((init as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ is_uploaded: true })
  })

  // --- Extra coverage beyond the brief's floor ---

  it('retrieves a page with GET and the API key', async () => {
    const fetchFn = vi.fn(async () =>
      json({ id: 'page-1', name: 'T', description_html: '<p>x</p>', updated_at: '2026-01-01T00:00:00Z' }),
    ) as unknown as typeof fetch
    const page = await client(fetchFn).getPage('page-1')
    expect(page).toEqual({ id: 'page-1', name: 'T', description_html: '<p>x</p>', updated_at: '2026-01-01T00:00:00Z' })
    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/page-1/')
    expect((init as RequestInit).method).toBe('GET')
    expect((init as { headers: Record<string, string> }).headers['X-API-Key']).toBe('k')
  })

  it('archives a page with POST', async () => {
    const fetchFn = vi.fn(async () => json({}, 200)) as unknown as typeof fetch
    await client(fetchFn).archivePage('page-1')
    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/page-1/archive/')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as { headers: Record<string, string> }).headers['X-API-Key']).toBe('k')
  })

  it('creates an asset upload with entity_type PAGE_DESCRIPTION and the API key', async () => {
    const fetchFn = vi.fn(async () =>
      json({ asset_id: 'a1', upload_data: { url: 'https://s3.test/bucket', fields: { key: 'k1' } } }),
    ) as unknown as typeof fetch
    const result = await client(fetchFn).createAssetUpload({
      name: 'flow.png',
      type: 'image/png',
      size: 3,
      entity_identifier: 'page-1',
    })
    expect(result).toEqual({ asset_id: 'a1', upload_data: { url: 'https://s3.test/bucket', fields: { key: 'k1' } } })

    const [url, init] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/assets/')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as { headers: Record<string, string> }).headers['X-API-Key']).toBe('k')
    const sentBody = JSON.parse((init as RequestInit).body as string)
    expect(sentBody).toEqual({
      name: 'flow.png',
      type: 'image/png',
      size: 3,
      entity_identifier: 'page-1',
      entity_type: 'PAGE_DESCRIPTION',
    })
  })

  it('produces no double slash when baseUrl has a trailing slash', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'page-1' }, 201)) as unknown as typeof fetch
    await client(fetchFn, 'https://plane.test/').createPage({ name: 'T', description_html: '<p>x</p>' })
    const [url] = callsOf(fetchFn)[0]!
    expect(url).toBe('https://plane.test/api/v1/workspaces/acme/pages/')
  })

  it('PlaneApiError carries the response body and names the method and path in its message', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 })) as unknown as typeof fetch
    try {
      await client(fetchFn).getPage('page-1')
      expect.unreachable('expected getPage to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PlaneApiError)
      const apiError = err as PlaneApiError
      expect(apiError.status).toBe(403)
      expect(apiError.body).toBe('{"error":"forbidden"}')
      expect(apiError.message).toMatch(/GET/)
      expect(apiError.message).toMatch(/\/pages\/page-1\//)
    }
  })

  it('does not throw parsing an empty 204 response body', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await expect(client(fetchFn).archivePage('page-1')).resolves.toBeUndefined()
  })

  it('surfaces a non-2xx on the presigned upload as PlaneApiError', async () => {
    const fetchFn = vi.fn(async () => new Response('access denied', { status: 403 })) as unknown as typeof fetch
    const upload = { asset_id: 'a1', upload_data: { url: 'https://s3.test/bucket', fields: { key: 'k1' } } }
    await expect(
      client(fetchFn).uploadAssetBytes(upload, new Uint8Array([1]), 'image/png', 'flow.png'),
    ).rejects.toBeInstanceOf(PlaneApiError)
  })
})
