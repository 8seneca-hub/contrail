import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { saveConnection } from './credentials.js'

/** The page that mints an API key. Plane has no device-authorization flow, so
 * the browser's job is to get the reader to the right screen; the key itself
 * comes back through the terminal. */
export function apiTokensUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/settings/profile/api-tokens/`
}

export function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  // Detached and unref'd: a browser that outlives the CLI must not hold it open,
  // and a machine with no browser at all should not turn login into a failure -
  // the URL is printed either way.
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref()
  } catch {
    // Printing the URL is the fallback, and the caller has already done it.
  }
}

/** Read one line, echoing nothing when stdin is a terminal.
 *
 * An API key pasted into a terminal otherwise stays in the scrollback and in
 * any screen-share running at the time.
 */
export async function promptSecret(question: string): Promise<string> {
  // Echo suppression only applies to a real terminal. Piped input (CI, a
  // password manager) has nothing on screen to hide, and readline exposes no
  // `_writeToOutput` to hook in that mode - reaching for it regardless is what
  // made `contrail login` crash when fed from a pipe.
  const interactive = process.stdin.isTTY === true
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive })
  const hidable = rl as unknown as { _writeToOutput?: (chunk: string) => void }
  const original = hidable._writeToOutput?.bind(rl)
  let muted = false
  if (original) {
    hidable._writeToOutput = (chunk: string) => {
      if (!muted) original(chunk)
      else if (chunk.includes('\n')) original('\n')
    }
  }
  try {
    const answer = rl.question(question)
    muted = true
    return (await answer).trim()
  } finally {
    muted = false
    rl.close()
  }
}

export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

export interface LoginRequest {
  baseUrl?: string
  workspace?: string
  openBrowserFirst?: boolean
}

export interface LoginDeps {
  ask: (question: string) => Promise<string>
  askSecret: (question: string) => Promise<string>
  open: (url: string) => void
  verify: (connection: { baseUrl: string; workspace: string; apiKey: string }) => Promise<void>
  log: (line: string) => void
  env?: NodeJS.ProcessEnv
}

/** `contrail login`: point at a Plane, collect an API key, prove it works, save it.
 *
 * The key is verified before it is written. Saving an unverified key trades a
 * failure here for a confusing one inside a later deploy, half way through an
 * upload.
 */
export async function runLogin(request: LoginRequest, deps: LoginDeps): Promise<string> {
  // Trimmed here rather than in the prompt: whether input arrives from a
  // terminal, a flag or a pipe, a stray space must not become part of a URL, a
  // workspace slug or a credential.
  const baseUrl = (request.baseUrl ?? (await deps.ask('Plane URL (e.g. https://plane.example.com): ')))
    .trim()
    .replace(/\/+$/, '')
  if (!baseUrl) throw new Error('A Plane URL is required.')

  const workspace = (request.workspace ?? (await deps.ask('Workspace slug: '))).trim()
  if (!workspace) throw new Error('A workspace slug is required.')

  const tokensUrl = apiTokensUrl(baseUrl)
  deps.log(`Opening ${tokensUrl}`)
  deps.log('Sign in if you need to, create an API key, and paste it below.')
  if (request.openBrowserFirst !== false) deps.open(tokensUrl)

  const apiKey = (await deps.askSecret('Plane API key: ')).trim()
  if (!apiKey) throw new Error('No API key was entered.')

  await deps.verify({ baseUrl, workspace, apiKey })
  return saveConnection({ baseUrl, workspace, apiKey }, deps.env)
}
