import { readFileSync } from 'node:fs'
import { google } from 'googleapis'
import { hashContent } from '../lock.js'
import type { Config } from '../types.js'

export interface SheetsApi {
  readRange(spreadsheetId: string, range: string): Promise<string[][]>
  writeRange(
    spreadsheetId: string,
    range: string,
    values: string[][],
    opts: { ifHash?: string; force?: boolean },
  ): Promise<{ hash: string }>
  createFromTemplate(templateId: string, title: string, parentId?: string): Promise<{ spreadsheetId: string }>
}

/** No credentials configured at all — an actionable message, not a stack trace. */
export class SheetsCredentialsError extends Error {}

/** A 403/404 from Google — nearly always means the Sheet was never shared with the service account. */
export class SheetsAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly spreadsheetId: string,
  ) {
    super(message)
    this.name = 'SheetsAccessError'
  }
}

/** The write guard refused: the range was edited since contrail last read it, and `force` was not set. */
export class SheetWriteGuardError extends Error {
  constructor(
    readonly spreadsheetId: string,
    readonly range: string,
    message: string,
  ) {
    super(message)
    this.name = 'SheetWriteGuardError'
  }
}

/** Minimal shape of `sheets.spreadsheets.values` actually used — the injectable seam, mirroring
 * `PlaneClient`'s `fetchFn`. A real `googleapis` client satisfies this structurally; tests pass a fake. */
export interface SheetsValuesApi {
  get(params: { spreadsheetId: string; range: string }): Promise<{ data: { values?: unknown[][] } }>
  update(params: {
    spreadsheetId: string
    range: string
    valueInputOption: string
    requestBody: { values: string[][] }
  }): Promise<unknown>
}

/** Minimal shape of `drive.files` actually used, for `createFromTemplate`. */
export interface DriveFilesApi {
  copy(params: {
    fileId: string
    requestBody: { name: string; parents?: string[] }
  }): Promise<{ data: { id?: string | null } }>
}

/** Hash of a range's values, used by the write guard and by the pull/push snapshot cache.
 * Reuses `hashContent`'s length-prefixed hashing rather than a second implementation. */
export function hashRange(values: string[][]): string {
  return hashContent([JSON.stringify(values)])
}

function normalizeRows(raw: unknown[][]): string[][] {
  return raw.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))))
}

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const candidate = err as { response?: { status?: number }; status?: number; code?: number | string }
  if (typeof candidate.response?.status === 'number') return candidate.response.status
  if (typeof candidate.status === 'number') return candidate.status
  if (typeof candidate.code === 'number') return candidate.code
  return undefined
}

export class GoogleSheetsClient implements SheetsApi {
  constructor(
    private readonly raw: { sheets: SheetsValuesApi; drive: DriveFilesApi },
    private readonly serviceAccountEmail?: string,
  ) {}

  private accessErrorFor(err: unknown, spreadsheetId: string): Error {
    const status = statusOf(err)
    if (status === 403 || status === 404) {
      const hint = this.serviceAccountEmail
        ? `Share the Sheet with ${this.serviceAccountEmail} (Editor access) and try again.`
        : "Share the Sheet with the service account's email — the `client_email` field in its " +
          'credentials JSON — and try again.'
      return new SheetsAccessError(
        `Google Sheets denied access to spreadsheet ${spreadsheetId} with HTTP ${status}. The most ` +
          `common cause is that this Sheet was never shared with the service account. ${hint}`,
        status,
        spreadsheetId,
      )
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  async readRange(spreadsheetId: string, range: string): Promise<string[][]> {
    try {
      const { data } = await this.raw.sheets.get({ spreadsheetId, range })
      return normalizeRows(data.values ?? [])
    } catch (err) {
      throw this.accessErrorFor(err, spreadsheetId)
    }
  }

  /**
   * The write guard: read the target range first, hash it, and compare against `ifHash` — the hash
   * recorded when contrail last read this range. A mismatch means a human edited it since, and the
   * write is refused unless `force`. A falsy or absent `ifHash` fails safe (refused, not bypassed):
   * unknown state must never be treated as permission to overwrite. This mirrors the Plane overwrite
   * guard in `src/plane/publish.ts` applied to a second system.
   */
  async writeRange(
    spreadsheetId: string,
    range: string,
    values: string[][],
    opts: { ifHash?: string; force?: boolean } = {},
  ): Promise<{ hash: string }> {
    const current = await this.readRange(spreadsheetId, range)

    if (!opts.force) {
      const knownIfHash = typeof opts.ifHash === 'string' && opts.ifHash.length > 0
      if (!knownIfHash || hashRange(current) !== opts.ifHash) {
        throw new SheetWriteGuardError(
          spreadsheetId,
          range,
          `${range} in spreadsheet ${spreadsheetId} was edited since contrail last read it; the write ` +
            'was refused. Re-run with --force only if that edit can be discarded.',
        )
      }
    }

    try {
      await this.raw.sheets.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      })
    } catch (err) {
      throw this.accessErrorFor(err, spreadsheetId)
    }

    // Read back what Sheets actually stored, not what we sent: Sheets can reformat values on the
    // way in, so hashing our own `values` would drift from the very next read's hash. Same lesson
    // as `remoteHash` in src/plane/publish.ts.
    const after = await this.readRange(spreadsheetId, range)
    return { hash: hashRange(after) }
  }

  async createFromTemplate(templateId: string, title: string, parentId?: string): Promise<{ spreadsheetId: string }> {
    try {
      const { data } = await this.raw.drive.copy({
        fileId: templateId,
        requestBody: { name: title, ...(parentId ? { parents: [parentId] } : {}) },
      })
      if (!data.id) throw new Error(`Drive copy of template ${templateId} returned no file id.`)
      return { spreadsheetId: data.id }
    } catch (err) {
      throw this.accessErrorFor(err, templateId)
    }
  }
}

/** `GOOGLE_APPLICATION_CREDENTIALS` wins over the config key, matching every other Google tool's
 * convention. Throws a named, actionable error rather than letting `googleapis` fail obscurely later. */
export function credentialsPathFor(config: Config): string {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS || config.sheets?.credentialsPath
  if (!path) {
    throw new SheetsCredentialsError(
      'No Google service-account credentials configured. Set the GOOGLE_APPLICATION_CREDENTIALS ' +
        'environment variable to the path of a service-account JSON key, or set `sheets.credentialsPath` ' +
        'in contrail.config.ts.',
    )
  }
  return path
}

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']

/** Builds a real `GoogleSheetsClient` from a service-account key file. The only function in this
 * module that touches the network or the filesystem for credentials — everything else is injectable. */
export async function createGoogleSheetsClient(credentialsPath: string): Promise<GoogleSheetsClient> {
  let raw: string
  try {
    raw = readFileSync(credentialsPath, 'utf8')
  } catch (err) {
    throw new SheetsCredentialsError(
      `Could not read Google service-account credentials at ${credentialsPath} ` +
        `(${err instanceof Error ? err.message : String(err)}). Check the GOOGLE_APPLICATION_CREDENTIALS ` +
        'environment variable or `sheets.credentialsPath` in contrail.config.ts.',
    )
  }

  // The service-account email is only a nicety for a later 403/404's error message; a malformed
  // key file surfaces its own clear failure from GoogleAuth itself once actually used.
  let clientEmail: string | undefined
  try {
    clientEmail = (JSON.parse(raw) as { client_email?: string }).client_email
  } catch {
    clientEmail = undefined
  }

  const auth = new google.auth.GoogleAuth({ keyFile: credentialsPath, scopes: SCOPES })
  const authClient = await auth.getClient()
  const sheets = google.sheets({ version: 'v4', auth: authClient as never })
  const drive = google.drive({ version: 'v3', auth: authClient as never })

  // `googleapis`' generated methods are overloaded for callback/stream variants our minimal
  // interfaces never use; the promise-returning shape we do use is a structural match, hence the cast.
  return new GoogleSheetsClient(
    { sheets: sheets.spreadsheets.values as unknown as SheetsValuesApi, drive: drive.files as unknown as DriveFilesApi },
    clientEmail,
  )
}
