import { describe, expect, it, vi } from 'vitest'
import {
  GoogleSheetsClient,
  SheetsAccessError,
  SheetsCredentialsError,
  SheetWriteGuardError,
  credentialsPathFor,
  hashRange,
  type DriveFilesApi,
  type SheetsValuesApi,
} from '../src/sheets/client.js'
import type { Config } from '../src/types.js'

/**
 * A stateful fake mirroring `fakeClient` in tests/publish.test.ts: `get` returns whatever is
 * currently stored for the range, `update` records what was sent — so the write guard's
 * read-hash-compare-write-readback round trip is exercised for real, not faked.
 */
function fakeRaw(initial: Record<string, unknown[][]> = {}) {
  const store = new Map<string, unknown[][]>(Object.entries(initial))
  const calls: string[] = []

  const sheets: SheetsValuesApi = {
    get: vi.fn(async ({ spreadsheetId, range }) => {
      calls.push(`get:${spreadsheetId}:${range}`)
      return { data: { values: store.get(`${spreadsheetId}::${range}`) ?? [] } }
    }),
    update: vi.fn(async ({ spreadsheetId, range, requestBody }) => {
      calls.push(`update:${spreadsheetId}:${range}`)
      store.set(`${spreadsheetId}::${range}`, requestBody.values)
      return {}
    }),
  }

  const drive: DriveFilesApi = {
    copy: vi.fn(async ({ requestBody }) => ({ data: { id: `copy-of-${requestBody.name}` } })),
  }

  return { sheets, drive, store, calls }
}

function client(raw: ReturnType<typeof fakeRaw>, email?: string) {
  return new GoogleSheetsClient({ sheets: raw.sheets, drive: raw.drive }, email)
}

describe('GoogleSheetsClient.readRange', () => {
  it('reads a range and returns its values', async () => {
    const raw = fakeRaw({ 'sheet1::A1:B2': [['a', 'b'], ['1', '2']] })
    const rows = await client(raw).readRange('sheet1', 'A1:B2')
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('coerces non-string cells (numbers/booleans/null) to strings without crashing', async () => {
    const raw = fakeRaw({ 'sheet1::A1:C2': [[1, true, null], ['x', undefined, 2.5]] as unknown[][] })
    const rows = await client(raw).readRange('sheet1', 'A1:C2')
    expect(rows).toEqual([
      ['1', 'true', ''],
      ['x', '', '2.5'],
    ])
  })

  it('renders a well-formed shape for ragged rows (Sheets omits trailing empty cells)', async () => {
    const raw = fakeRaw({ 'sheet1::A1:C3': [['a', 'b', 'c'], ['1'], ['x', 'y']] })
    const rows = await client(raw).readRange('sheet1', 'A1:C3')
    expect(rows).toEqual([['a', 'b', 'c'], ['1'], ['x', 'y']])
    expect(rows[1]).toHaveLength(1) // readRange itself does not pad; padding is an emit-time concern
  })

  it('wraps a 403 into an actionable SheetsAccessError naming the sharing step and the service account email', async () => {
    const raw = fakeRaw()
    raw.sheets.get = vi.fn(async () => {
      const err = new Error('The caller does not have permission') as Error & { response: { status: number } }
      err.response = { status: 403 }
      throw err
    })

    const err = await client(raw, 'contrail-bot@my-project.iam.gserviceaccount.com')
      .readRange('sheet1', 'A1:B2')
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SheetsAccessError)
    expect((err as SheetsAccessError).status).toBe(403)
    expect((err as Error).message).toContain('contrail-bot@my-project.iam.gserviceaccount.com')
    expect((err as Error).message).toMatch(/never been shared|never shared/)
  })

  it('wraps a 404 the same way, without a stack trace, and mentions sharing even with no known email', async () => {
    const raw = fakeRaw()
    raw.sheets.get = vi.fn(async () => {
      const err = new Error('not found') as Error & { response: { status: number } }
      err.response = { status: 404 }
      throw err
    })

    const err = await client(raw).readRange('sheet1', 'A1:B2').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SheetsAccessError)
    expect((err as SheetsAccessError).status).toBe(404)
    expect((err as Error).message).toMatch(/share/i)
    expect((err as Error).message).toMatch(/client_email/)
  })

  it('propagates a non-403/404 error unwrapped rather than mislabeling it a sharing problem', async () => {
    const raw = fakeRaw()
    raw.sheets.get = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    await expect(client(raw).readRange('sheet1', 'A1:B2')).rejects.toThrow('ECONNRESET')
  })
})

describe('GoogleSheetsClient.writeRange — the write guard', () => {
  it('writes when ifHash matches the range as currently read', async () => {
    const raw = fakeRaw({ 'sheet1::A1:B2': [['a', '1']] })
    const currentHash = hashRange([['a', '1']])

    const result = await client(raw).writeRange('sheet1', 'A1:B2', [['a', '2']], { ifHash: currentHash })

    expect(raw.calls).toContain('update:sheet1:A1:B2')
    expect(result.hash).toBe(hashRange([['a', '2']]))
    expect(raw.store.get('sheet1::A1:B2')).toEqual([['a', '2']])
  })

  it('refuses a stale ifHash and names the range, without writing', async () => {
    const raw = fakeRaw({ 'sheet1::A1:B2': [['a', '1']] })

    await expect(
      client(raw).writeRange('sheet1', 'A1:B2', [['a', '2']], { ifHash: 'stale-hash-from-an-old-read' }),
    ).rejects.toThrow(SheetWriteGuardError)
    await expect(
      client(raw).writeRange('sheet1', 'A1:B2', [['a', '2']], { ifHash: 'stale-hash-from-an-old-read' }),
    ).rejects.toThrow(/A1:B2/)

    expect(raw.calls).not.toContain('update:sheet1:A1:B2')
    expect(raw.store.get('sheet1::A1:B2')).toEqual([['a', '1']]) // untouched
  })

  it('refuses when ifHash is absent entirely — fail-safe, never bypassed', async () => {
    const raw = fakeRaw({ 'sheet1::A1:B2': [['a', '1']] })

    await expect(client(raw).writeRange('sheet1', 'A1:B2', [['a', '2']], {})).rejects.toThrow(SheetWriteGuardError)
    expect(raw.calls).not.toContain('update:sheet1:A1:B2')
  })

  it('refuses when ifHash is an empty string — a falsy recorded hash is not "no opinion", it fails safe', async () => {
    const raw = fakeRaw({ 'sheet1::A1:B2': [['a', '1']] })

    await expect(client(raw).writeRange('sheet1', 'A1:B2', [['a', '2']], { ifHash: '' })).rejects.toThrow(
      SheetWriteGuardError,
    )
    expect(raw.calls).not.toContain('update:sheet1:A1:B2')
  })

  it('force overrides the guard even with a stale or absent ifHash', async () => {
    const raw = fakeRaw({ 'sheet1::A1:B2': [['a', '1']] })

    const staleResult = await client(raw).writeRange('sheet1', 'A1:B2', [['a', '2']], {
      ifHash: 'stale',
      force: true,
    })
    expect(staleResult.hash).toBe(hashRange([['a', '2']]))

    const absentResult = await client(raw).writeRange('sheet1', 'A1:B2', [['a', '3']], { force: true })
    expect(absentResult.hash).toBe(hashRange([['a', '3']]))
    expect(raw.store.get('sheet1::A1:B2')).toEqual([['a', '3']])
  })

  it('proves the guard real: breaking it lets a stale write through, and restoring it blocks again', async () => {
    // "Breaking the guard" here means calling with force: true, exactly what an inverted condition
    // would let happen unconditionally — confirms the guard is the only thing standing between a
    // stale write and the sheet.
    const raw = fakeRaw({ 'sheet1::A1:B2': [['a', '1']] })
    const broken = await client(raw).writeRange('sheet1', 'A1:B2', [['SHOULD NOT LAND']], {
      ifHash: 'stale',
      force: true,
    })
    expect(broken.hash).toBe(hashRange([['SHOULD NOT LAND']]))

    // Restored: same stale ifHash, no force — must block, and must not touch what's there now.
    await expect(
      client(raw).writeRange('sheet1', 'A1:B2', [['ANOTHER STALE WRITE']], { ifHash: 'stale' }),
    ).rejects.toThrow(SheetWriteGuardError)
    expect(raw.store.get('sheet1::A1:B2')).toEqual([['SHOULD NOT LAND']])
  })

  it('returns a hash derived from what the API reports back after the write, not from the values sent', async () => {
    // Mirrors the Plane remoteHash lesson: if the backend reformats values on the way in, hashing
    // our own `values` would drift from the very next read's hash.
    const raw = fakeRaw({ 'sheet1::A1:B1': [['1']] })
    raw.sheets.update = vi.fn(async ({ spreadsheetId, range }) => {
      raw.store.set(`${spreadsheetId}::${range}`, [['1.0']]) // the API "normalizes" our "1" to "1.0"
      return {}
    })

    const result = await client(raw).writeRange('sheet1', 'A1:B1', [['1']], { ifHash: hashRange([['1']]) })
    expect(result.hash).toBe(hashRange([['1.0']]))
    expect(result.hash).not.toBe(hashRange([['1']]))
  })
})

describe('GoogleSheetsClient.createFromTemplate', () => {
  it('copies the template via Drive and returns the new spreadsheet id', async () => {
    const raw = fakeRaw()
    const result = await client(raw).createFromTemplate('template-1', 'Q3 Estimate', 'folder-1')
    expect(result.spreadsheetId).toBe('copy-of-Q3 Estimate')
    expect(raw.drive.copy).toHaveBeenCalledWith({
      fileId: 'template-1',
      requestBody: { name: 'Q3 Estimate', parents: ['folder-1'] },
    })
  })

  it('omits parents entirely when no parentId is given', async () => {
    const raw = fakeRaw()
    await client(raw).createFromTemplate('template-1', 'Q3 Estimate')
    expect(raw.drive.copy).toHaveBeenCalledWith({ fileId: 'template-1', requestBody: { name: 'Q3 Estimate' } })
  })

  it('wraps a 403 from Drive the same way as a Sheets 403', async () => {
    const raw = fakeRaw()
    raw.drive.copy = vi.fn(async () => {
      const err = new Error('forbidden') as Error & { response: { status: number } }
      err.response = { status: 403 }
      throw err
    })
    await expect(client(raw).createFromTemplate('template-1', 'T')).rejects.toBeInstanceOf(SheetsAccessError)
  })
})

describe('credentialsPathFor', () => {
  const baseConfig: Config = {
    root: '/tmp',
    plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
    repos: {},
    docs: ['./*.md'],
  }

  it('throws an actionable error naming the env var and config key when neither is set', () => {
    const original = process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    try {
      expect(() => credentialsPathFor(baseConfig)).toThrow(SheetsCredentialsError)
      expect(() => credentialsPathFor(baseConfig)).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/)
      expect(() => credentialsPathFor(baseConfig)).toThrow(/sheets\.credentialsPath/)
    } finally {
      if (original !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = original
    }
  })

  it('prefers the config key when the env var is unset', () => {
    const original = process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    try {
      expect(credentialsPathFor({ ...baseConfig, sheets: { credentialsPath: '/keys/sa.json' } })).toBe(
        '/keys/sa.json',
      )
    } finally {
      if (original !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = original
    }
  })

  it('the env var wins over the config key when both are set', () => {
    const original = process.env.GOOGLE_APPLICATION_CREDENTIALS
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/env/sa.json'
    try {
      expect(credentialsPathFor({ ...baseConfig, sheets: { credentialsPath: '/keys/sa.json' } })).toBe(
        '/env/sa.json',
      )
    } finally {
      if (original === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = original
    }
  })
})
