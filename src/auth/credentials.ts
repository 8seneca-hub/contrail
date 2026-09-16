import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface PlaneConnection {
  baseUrl: string
  workspace: string
  apiKey: string
  savedAt: string
}

/** Where the saved Plane connection lives.
 *
 * `XDG_CONFIG_HOME` is honoured so a test can point this somewhere disposable,
 * and so a machine that sets it does not get a stray `~/.config`.
 */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config')
  return join(base, 'contrail', 'credentials.json')
}

export function loadConnection(env: NodeJS.ProcessEnv = process.env): PlaneConnection | undefined {
  const path = credentialsPath(env)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PlaneConnection>
    if (!parsed.baseUrl || !parsed.workspace || !parsed.apiKey) return undefined
    return parsed as PlaneConnection
  } catch {
    // A truncated or hand-edited file is not worth crashing over: the caller
    // treats a missing connection as "not logged in", which is recoverable by
    // running `contrail login` again.
    return undefined
  }
}

export function saveConnection(connection: Omit<PlaneConnection, 'savedAt'>, env: NodeJS.ProcessEnv = process.env): string {
  const path = credentialsPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const record: PlaneConnection = { ...connection, savedAt: new Date().toISOString() }
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  // `writeFileSync`'s mode applies only when it creates the file, so an
  // existing one keeps whatever permissions it had. This holds an API key.
  chmodSync(path, 0o600)
  return path
}

export function clearConnection(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = credentialsPath(env)
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}
