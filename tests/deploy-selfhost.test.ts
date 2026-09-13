import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertBuildNotEmpty, deploy, parseDeployTarget } from '../src/deploy.js'
import type { DeployTransport } from '../src/deploy/transport.js'
import { parseDoc } from '../src/parse.js'
import type { Config, Doc } from '../src/types.js'

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), 'contrail-selfhost-'))
}

function writeDoc(root: string, rel: string, frontmatterExtra = ''): Doc {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `---\ntitle: T\nsummary: S\nstatus: current\n${frontmatterExtra}---\n\nBody.\n`)
  return parseDoc(path, root)
}

function configFor(root: string, selfhost?: Config['selfhost']): Config {
  return {
    root,
    plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
    repos: {},
    docs: ['./docs/**/*.md'],
    selfhost,
  }
}

const SELFHOST = {
  target: 'railway' as const,
  volume: 'docs-volume',
  slug: 'meridian',
  internalPath: '/srv/contrail/internal',
  clientPath: '/srv/contrail/client',
}

function fakeTransport(): { transport: DeployTransport; calls: Array<[string, string, { dryRun?: boolean }]> } {
  const calls: Array<[string, string, { dryRun?: boolean }]> = []
  const transport: DeployTransport = {
    name: 'fake',
    push: vi.fn(async (localDir: string, remotePath: string, opts: { dryRun?: boolean }) => {
      calls.push([localDir, remotePath, opts])
      return { filesSent: 3 }
    }),
  }
  return { transport, calls }
}

describe('parseDeployTarget', () => {
  it('defaults to vercel, accepts railway, and rejects anything else', () => {
    expect(parseDeployTarget(undefined)).toBe('vercel')
    expect(parseDeployTarget('vercel')).toBe('vercel')
    expect(parseDeployTarget('railway')).toBe('railway')
    expect(() => parseDeployTarget('ssh')).toThrow(/Unknown --target/)
  })
})

describe('assertBuildNotEmpty', () => {
  it('aborts when the directory is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-build-'))
    expect(() => assertBuildNotEmpty(dir)).toThrow(/is empty/)
  })

  it('aborts when the directory has files but no index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-build-'))
    writeFileSync(join(dir, 'about.html'), '<html></html>')
    expect(() => assertBuildNotEmpty(dir)).toThrow(/no index\.html/)
  })

  it('does not throw when index.html is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contrail-build-'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    expect(() => assertBuildNotEmpty(dir)).not.toThrow()
  })

  it('aborts when the directory does not exist at all', () => {
    expect(() => assertBuildNotEmpty(join(tmpdir(), 'contrail-does-not-exist-xyz'))).toThrow(/does not exist/)
  })
})

describe('contrail deploy --target railway', () => {
  it('never invokes a real transport CLI — the transport is injected — and composes the internal destination path', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const config = configFor(root, SELFHOST)
    const { transport, calls } = fakeTransport()

    const result = await deploy({
      config,
      docs: [doc],
      audience: 'internal',
      target: 'railway',
      runner: async () => ({ code: 0 }),
      transport,
    })

    expect(result.status).toBe('deployed')
    expect(result.remotePath).toBe('/srv/contrail/internal/meridian')
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe(join(root, 'site'))
    expect(calls[0]![1]).toBe('/srv/contrail/internal/meridian')
  })

  it('composes the client destination path', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md', 'audience: client\n')
    const config = configFor(root, SELFHOST)
    const { transport, calls } = fakeTransport()

    const result = await deploy({
      config,
      docs: [doc],
      audience: 'client',
      target: 'railway',
      runner: async () => ({ code: 0 }),
      transport,
    })

    expect(result.status).toBe('deployed')
    expect(result.remotePath).toBe('/srv/contrail/client/meridian')
    expect(calls[0]![1]).toBe('/srv/contrail/client/meridian')
  })

  it('aborts with no `selfhost` configured, naming --target railway', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const config = configFor(root, undefined)
    const { transport, calls } = fakeTransport()

    await expect(
      deploy({ config, docs: [doc], audience: 'internal', target: 'railway', runner: async () => ({ code: 0 }), transport }),
    ).rejects.toThrow(/selfhost.*--target railway/)
    expect(calls).toHaveLength(0)
  })

  it('identical internal/client paths abort, naming both', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const config = configFor(root, { ...SELFHOST, clientPath: SELFHOST.internalPath })
    const { transport, calls } = fakeTransport()

    await expect(
      deploy({ config, docs: [doc], audience: 'internal', target: 'railway', runner: async () => ({ code: 0 }), transport }),
    ).rejects.toThrow(/internalPath.*clientPath.*both/)
    expect(calls).toHaveLength(0)
  })

  it('a slug containing ../ is rejected', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const config = configFor(root, { ...SELFHOST, slug: '../escape' })
    const { transport, calls } = fakeTransport()

    await expect(
      deploy({ config, docs: [doc], audience: 'internal', target: 'railway', runner: async () => ({ code: 0 }), transport }),
    ).rejects.toThrow(/Invalid `selfhost\.slug`/)
    expect(calls).toHaveLength(0)
  })

  it('a slug with a leading / is rejected', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const config = configFor(root, { ...SELFHOST, slug: '/etc' })
    const { transport, calls } = fakeTransport()

    await expect(
      deploy({ config, docs: [doc], audience: 'internal', target: 'railway', runner: async () => ({ code: 0 }), transport }),
    ).rejects.toThrow(/Invalid `selfhost\.slug`/)
    expect(calls).toHaveLength(0)
  })

  it('--dry-run invokes the transport with dryRun: true and reports dry-run status, without deploying', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const config = configFor(root, SELFHOST)
    const { transport, calls } = fakeTransport()

    const result = await deploy({
      config,
      docs: [doc],
      audience: 'internal',
      target: 'railway',
      dryRun: true,
      runner: async () => ({ code: 0 }),
      transport,
    })

    expect(result.status).toBe('dry-run')
    expect(calls).toHaveLength(1)
    expect(calls[0]![2]).toEqual({ dryRun: true })
  })

  it('requires a transport for --target railway', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const config = configFor(root, SELFHOST)

    await expect(
      deploy({ config, docs: [doc], audience: 'internal', target: 'railway', runner: async () => ({ code: 0 }) }),
    ).rejects.toThrow(/requires a transport/)
  })

  it('the existing vercel target is untouched when `target` is omitted', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    mkdirSync(join(root, '.vercel'), { recursive: true })
    writeFileSync(join(root, '.vercel', 'project.json'), JSON.stringify({ projectName: 'meridian-internal' }))
    const config: Config = {
      root,
      plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
      repos: {},
      docs: ['./docs/**/*.md'],
      vercel: { internalProject: 'meridian-internal', clientProject: 'meridian-client' },
    }
    const calls: Array<[string, string[]]> = []
    const runner = vi.fn(async (command: string, args: string[]) => {
      calls.push([command, args])
      return { code: 0 }
    })

    const result = await deploy({ config, docs: [doc], audience: 'internal', runner })

    expect(result.status).toBe('deployed')
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('vercel')
  })
})
