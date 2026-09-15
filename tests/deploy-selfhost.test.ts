import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertBuildNotEmpty, deploy, parseDeployTarget } from '../src/deploy.js'
import type { DeployTransport } from '../src/deploy/transport.js'
import { buildSite } from '../src/emit/site.js'
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
  it('defaults to vercel, accepts plane and railway, and rejects anything else', () => {
    expect(parseDeployTarget(undefined)).toBe('vercel')
    expect(parseDeployTarget('vercel')).toBe('vercel')
    expect(parseDeployTarget('railway')).toBe('railway')
    expect(parseDeployTarget('plane')).toBe('plane')
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

  // --target plane: the server owns the layout, so the only thing the transport is told is which
  // audience this build is. See docs/plane-docs-api-spec.md.
  it('passes the audience as the remote path for --target plane, and builds per audience', async () => {
    const root = fixtureRoot()
    const internal = writeDoc(root, 'docs/03-management/budget.md')
    const shared = writeDoc(root, 'docs/01-overview/brief.md', 'audience: client\n')
    const config = configFor(root, { target: 'plane', projectId: 'proj-123' })
    const { transport, calls } = fakeTransport()

    const result = await deploy({
      config,
      docs: [internal, shared],
      audience: 'client',
      target: 'plane',
      transport,
      runner: async () => ({ code: 0 }),
    })

    expect(calls[0]![1]).toBe('client')
    expect(result.remotePath).toBe('client')
    expect(result.docCount).toBe(1)
  })

  it('aborts when --target disagrees with the configured selfhost target', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const { transport } = fakeTransport()

    await expect(
      deploy({
        config: configFor(root, SELFHOST),
        docs: [doc],
        audience: 'internal',
        target: 'plane',
        transport,
        runner: async () => ({ code: 0 }),
      }),
    ).rejects.toThrow(/--target plane.*selfhost\.target: 'railway'/s)
  })

  it('aborts with no `selfhost` configured, naming --target plane and the plane config shape', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')

    await expect(
      deploy({
        config: configFor(root),
        docs: [doc],
        audience: 'internal',
        target: 'plane',
        runner: async () => ({ code: 0 }),
      }),
    ).rejects.toThrow(/--target plane.*projectId/s)
  })

  it('requires a transport for --target plane, naming the plane one', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')

    await expect(
      deploy({
        config: configFor(root, { target: 'plane', projectId: 'proj-123' }),
        docs: [doc],
        audience: 'internal',
        target: 'plane',
        runner: async () => ({ code: 0 }),
      }),
    ).rejects.toThrow(/createPlaneDocsTransport/)
  })

  // Finding 1(a): `llms.txt` was written only by `contrail site` — every self-hosted deploy path
  // must write its own too, filtered by that deploy's own audience, or the build it pushes has no
  // agent index at all.
  it('writes llms.txt into the build output before pushing, filtered by the deploy audience', async () => {
    const root = fixtureRoot()
    const internalDoc = writeDoc(root, 'docs/03-management/budget.md')
    const clientDoc = writeDoc(root, 'docs/01-overview/brief.md', 'audience: client\n')
    const config = configFor(root, { target: 'plane', projectId: 'proj-123' })
    const { transport } = fakeTransport()

    await deploy({
      config,
      docs: [internalDoc, clientDoc],
      audience: 'client',
      target: 'plane',
      transport,
      runner: async () => ({ code: 0 }),
    })

    const llmsTxt = readFileSync(join(root, 'site', 'llms.txt'), 'utf8')
    expect(llmsTxt).toContain('01-overview/brief.html')
    expect(llmsTxt).not.toContain('03-management/budget.html')
  })

  // Finding 1(b): `contrail site` and `contrail deploy` resolve the same output directory
  // (`siteOutDirFor`) when `--out` is omitted, and `buildSite` never used to clean it. So
  // `contrail site` (unfiltered — every document, including internal-only ones) followed by
  // `contrail deploy --audience client --target plane` into the same directory would upload the
  // stale internal page and the stale internal llms.txt right alongside the client-only build —
  // the exact leak this finding is about.
  it('a stale internal page from a previous unfiltered `site` build does not survive into a client deploy sharing the same outDir', async () => {
    const root = fixtureRoot()
    const internalDoc = writeDoc(root, 'docs/03-management/budget.md')
    const clientDoc = writeDoc(root, 'docs/01-overview/brief.md', 'audience: client\n')
    const config = configFor(root, { target: 'plane', projectId: 'proj-123' })
    const outDir = join(root, 'site')

    // Simulate a prior `contrail site` run: unfiltered, so it writes the internal-only page.
    await buildSite({ docs: [internalDoc, clientDoc], outDir, cacheDir: join(root, '.contrail', 'cache') })
    expect(existsSync(join(outDir, '03-management', 'budget.html'))).toBe(true)

    const { transport } = fakeTransport()
    await deploy({
      config,
      docs: [internalDoc, clientDoc],
      audience: 'client',
      target: 'plane',
      outDir,
      transport,
      runner: async () => ({ code: 0 }),
    })

    expect(existsSync(join(outDir, '03-management', 'budget.html'))).toBe(false)
    expect(existsSync(join(outDir, '03-management'))).toBe(false)
    const llmsTxt = readFileSync(join(outDir, 'llms.txt'), 'utf8')
    expect(llmsTxt).not.toContain('03-management/budget.html')
  })
})
