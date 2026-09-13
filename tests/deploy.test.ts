import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { deploy, readLinkedProject, parseDeployAudience, type CliResult, type CliRunner } from '../src/deploy.js'
import { parseDoc } from '../src/parse.js'
import type { Config, Doc } from '../src/types.js'

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), 'contrail-deploy-'))
}

function writeDoc(root: string, rel: string, frontmatterExtra = ''): Doc {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `---\ntitle: T\nsummary: S\nstatus: current\n${frontmatterExtra}---\n\nBody.\n`)
  return parseDoc(path, root)
}

function link(root: string, projectName: string): void {
  mkdirSync(join(root, '.vercel'), { recursive: true })
  writeFileSync(join(root, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_x', projectName }))
}

function configFor(root: string, vercel?: Config['vercel']): Config {
  return {
    root,
    plane: { baseUrl: 'https://plane.test', workspace: 'acme' },
    repos: {},
    docs: ['./docs/**/*.md'],
    vercel,
  }
}

function fakeRunner(code = 0): { runner: CliRunner; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = []
  const runner: CliRunner = vi.fn(async (command: string, args: string[]): Promise<CliResult> => {
    calls.push([command, args])
    return { code }
  })
  return { runner, calls }
}

describe('contrail deploy', () => {
  it('never invokes a real CLI — the runner is injected and called with the built directory', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    link(root, 'meridian-internal')
    const config = configFor(root, { internalProject: 'meridian-internal', clientProject: 'meridian-client' })
    const { runner, calls } = fakeRunner()

    const result = await deploy({ config, docs: [doc], audience: 'internal', runner })

    expect(result.status).toBe('deployed')
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('vercel')
    expect(calls[0]![1]).toContain('--prebuilt')
    expect(calls[0]![1]).toContain(join(root, 'site'))
  })

  it('a project mismatch aborts and names both the expected and the actual project', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    link(root, 'some-other-project')
    const config = configFor(root, { internalProject: 'meridian-internal', clientProject: 'meridian-client' })
    const { runner, calls } = fakeRunner()

    await expect(deploy({ config, docs: [doc], audience: 'internal', runner })).rejects.toThrow(
      /some-other-project/,
    )
    await expect(deploy({ config, docs: [doc], audience: 'internal', runner })).rejects.toThrow(
      /meridian-internal/,
    )
    expect(calls).toHaveLength(0)
  })

  it('a client production deploy without --yes prints what it would publish and does not deploy', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md', 'audience: client\n')
    link(root, 'meridian-client')
    const config = configFor(root, { internalProject: 'meridian-internal', clientProject: 'meridian-client' })
    const { runner, calls } = fakeRunner()
    const confirm = vi.fn(async () => false)

    const result = await deploy({
      config,
      docs: [doc],
      audience: 'client',
      prod: true,
      runner,
      confirm,
    })

    expect(result.status).toBe('declined')
    expect(calls).toHaveLength(0)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('a client production deploy proceeds once confirmed (or --yes is passed)', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md', 'audience: client\n')
    link(root, 'meridian-client')
    const config = configFor(root, { internalProject: 'meridian-internal', clientProject: 'meridian-client' })
    const { runner, calls } = fakeRunner()

    const result = await deploy({ config, docs: [doc], audience: 'client', prod: true, yes: true, runner })

    expect(result.status).toBe('deployed')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toContain('--prod')
  })

  it('--dry-run prints the command and file count and invokes nothing', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    link(root, 'meridian-internal')
    const config = configFor(root, { internalProject: 'meridian-internal', clientProject: 'meridian-client' })
    const { runner, calls } = fakeRunner()

    const result = await deploy({ config, docs: [doc], audience: 'internal', dryRun: true, runner })

    expect(result.status).toBe('dry-run')
    expect(result.fileCount).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
  })

  it('a missing .vercel/project.json produces an actionable message telling the user to run `vercel link`', async () => {
    const root = fixtureRoot()
    const doc = writeDoc(root, 'docs/01-overview/brief.md')
    const config = configFor(root, { internalProject: 'meridian-internal', clientProject: 'meridian-client' })
    const { runner, calls } = fakeRunner()

    await expect(deploy({ config, docs: [doc], audience: 'internal', runner })).rejects.toThrow(/vercel link/)
    expect(readLinkedProject(root)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('parseDeployAudience defaults to internal, accepts client, and rejects anything else', () => {
    expect(parseDeployAudience(undefined)).toBe('internal')
    expect(parseDeployAudience('internal')).toBe('internal')
    expect(parseDeployAudience('client')).toBe('client')
    expect(() => parseDeployAudience('bogus')).toThrow(/Unknown --audience/)
  })
})
