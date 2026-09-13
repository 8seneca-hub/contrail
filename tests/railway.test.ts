import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createRailwayTransport } from '../src/deploy/railway.js'
import type { CliResult, CliRunner } from '../src/deploy.js'

function fixtureDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'contrail-railway-'))
  for (const rel of files) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'x')
  }
  return dir
}

function fakeRunner(code = 0): { runner: CliRunner; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = []
  const runner: CliRunner = vi.fn(async (command: string, args: string[]): Promise<CliResult> => {
    calls.push([command, args])
    return { code }
  })
  return { runner, calls }
}

describe('createRailwayTransport', () => {
  it('shells out to `railway volume files --volume <volume> upload <local> <remote> --overwrite --concurrency 32`', async () => {
    const dir = fixtureDir(['index.html', 'a/b.html'])
    const { runner, calls } = fakeRunner()
    const transport = createRailwayTransport(runner, { volume: 'docs-volume' })

    const result = await transport.push(dir, '/srv/contrail/internal/meridian', {})

    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('railway')
    expect(calls[0]![1]).toEqual([
      'volume',
      'files',
      '--volume',
      'docs-volume',
      'upload',
      dir,
      '/srv/contrail/internal/meridian',
      '--overwrite',
      '--concurrency',
      '32',
    ])
    expect(result.filesSent).toBe(2)
  })

  it('passes --service before the subcommand when configured', async () => {
    const dir = fixtureDir(['index.html'])
    const { runner, calls } = fakeRunner()
    const transport = createRailwayTransport(runner, { volume: 'docs-volume', service: 'docs-service' })

    await transport.push(dir, '/srv/contrail/client/meridian', {})

    expect(calls[0]![1]).toEqual([
      'volume',
      'files',
      '--volume',
      'docs-volume',
      '--service',
      'docs-service',
      'upload',
      dir,
      '/srv/contrail/client/meridian',
      '--overwrite',
      '--concurrency',
      '32',
    ])
  })

  it('--dry-run never invokes the runner, but still reports the file count', async () => {
    const dir = fixtureDir(['index.html', 'a.html', 'b.html'])
    const { runner, calls } = fakeRunner()
    const transport = createRailwayTransport(runner, { volume: 'docs-volume' })

    const result = await transport.push(dir, '/srv/contrail/internal/meridian', { dryRun: true })

    expect(calls).toHaveLength(0)
    expect(result.filesSent).toBe(3)
  })

  it('throws when the runner exits non-zero', async () => {
    const dir = fixtureDir(['index.html'])
    const { runner } = fakeRunner(1)
    const transport = createRailwayTransport(runner, { volume: 'docs-volume' })

    await expect(transport.push(dir, '/srv/contrail/internal/meridian', {})).rejects.toThrow(/railway exited with code 1/)
  })
})
