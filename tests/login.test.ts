import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apiTokensUrl, runLogin, type LoginDeps } from '../src/auth/login.js'
import { clearConnection, credentialsPath, loadConnection, saveConnection } from '../src/auth/credentials.js'

function scratchEnv(): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'contrail-cfg-')) }
}

function deps(overrides: Partial<LoginDeps> = {}): LoginDeps & { opened: string[]; logs: string[] } {
  const opened: string[] = []
  const logs: string[] = []
  return {
    opened,
    logs,
    ask: async () => '',
    askSecret: async () => 'plane_api_deadbeef',
    open: (url) => opened.push(url),
    verify: async () => {},
    log: (line) => logs.push(line),
    ...overrides,
  }
}

describe('apiTokensUrl', () => {
  it('points at the page that actually mints a key, with no double slash', () => {
    expect(apiTokensUrl('https://plane.test/')).toBe('https://plane.test/settings/profile/api-tokens/')
  })
})

describe('runLogin', () => {
  it('opens the browser, verifies the key, and saves the connection', async () => {
    const env = scratchEnv()
    const d = deps({ env })

    const path = await runLogin({ baseUrl: 'https://plane.test', workspace: 'acme' }, d)

    expect(d.opened).toEqual(['https://plane.test/settings/profile/api-tokens/'])
    expect(loadConnection(env)).toMatchObject({
      baseUrl: 'https://plane.test',
      workspace: 'acme',
      apiKey: 'plane_api_deadbeef',
    })
    expect(readFileSync(path, 'utf8')).toContain('plane_api_deadbeef')
  })

  it('writes the key owner-readable only', async () => {
    const env = scratchEnv()
    const path = await runLogin({ baseUrl: 'https://plane.test', workspace: 'acme' }, deps({ env }))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('tightens permissions on a file that already existed', async () => {
    const env = scratchEnv()
    const path = credentialsPath(env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{}', { mode: 0o644 })

    await runLogin({ baseUrl: 'https://plane.test', workspace: 'acme' }, deps({ env }))

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('never saves a key the server rejected', async () => {
    const env = scratchEnv()
    const d = deps({ env, verify: async () => { throw new Error('Plane GET /projects/ failed with 401') } })

    await expect(runLogin({ baseUrl: 'https://plane.test', workspace: 'acme' }, d)).rejects.toThrow('401')
    expect(loadConnection(env)).toBeUndefined()
  })

  it('skips the browser when asked, and still prints the URL', async () => {
    const env = scratchEnv()
    const d = deps({ env })
    await runLogin({ baseUrl: 'https://plane.test', workspace: 'acme', openBrowserFirst: false }, d)

    expect(d.opened).toEqual([])
    expect(d.logs.join('\n')).toContain('https://plane.test/settings/profile/api-tokens/')
  })

  it('prompts for what it was not given', async () => {
    const env = scratchEnv()
    const asked: string[] = []
    const d = deps({
      env,
      ask: async (question) => {
        asked.push(question)
        return question.startsWith('Plane URL') ? 'https://asked.test' : 'asked-workspace'
      },
    })

    await runLogin({}, d)

    expect(asked).toHaveLength(2)
    expect(loadConnection(env)).toMatchObject({ baseUrl: 'https://asked.test', workspace: 'asked-workspace' })
  })

  it('refuses an empty key rather than saving one that cannot work', async () => {
    const env = scratchEnv()
    await expect(
      runLogin({ baseUrl: 'https://plane.test', workspace: 'acme' }, deps({ env, askSecret: async () => '  ' })),
    ).rejects.toThrow('No API key was entered.')
    expect(loadConnection(env)).toBeUndefined()
  })
})

describe('credential store', () => {
  it('reports no connection rather than crashing on a corrupt file', () => {
    const env = scratchEnv()
    const path = credentialsPath(env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{ not json')
    expect(loadConnection(env)).toBeUndefined()
  })

  it('treats a file missing the key as not connected', () => {
    const env = scratchEnv()
    const path = credentialsPath(env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ baseUrl: 'https://plane.test', workspace: 'acme' }))
    expect(loadConnection(env)).toBeUndefined()
  })

  it('clears the connection and says whether there was one', () => {
    const env = scratchEnv()
    expect(clearConnection(env)).toBe(false)
    saveConnection({ baseUrl: 'https://plane.test', workspace: 'acme', apiKey: 'k' }, env)
    expect(clearConnection(env)).toBe(true)
    expect(existsSync(credentialsPath(env))).toBe(false)
  })
})
