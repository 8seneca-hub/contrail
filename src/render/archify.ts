import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArchifyType } from '../blocks/archify.js'

export type ArchifyRunner = (args: string[]) => Promise<{ stdout: string; code: number }>

export interface ArchifyOptions {
  /** Absolute path to the Archify CLI. Defaults to `archify` resolved from PATH. */
  bin?: string
  /** Injected for tests; never the real binary. */
  runner?: ArchifyRunner
}

export interface RenderedArchify {
  hash: string
  htmlPath: string
  irPath: string
}

export class ArchifyValidationError extends Error {}

const spawnArchify =
  (bin: string): ArchifyRunner =>
  (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ stdout, code: code ?? 1 }))
    })

function binFor(opts: ArchifyOptions): string {
  return opts.bin ?? 'archify'
}

function runnerFor(opts: ArchifyOptions): ArchifyRunner {
  return opts.runner ?? spawnArchify(binFor(opts))
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * A first-time user with no `archify` on PATH and no `config.archify.bin` gets
 * a raw `spawn archify ENOENT` otherwise — which names no problem and no fix.
 * Rethrow with the actual install path; every other error propagates as-is.
 */
function enoentMessage(bin: string): string {
  return (
    `Archify was not found (tried to run \`${bin}\`). Install it with:\n` +
    '  npx skills add tt-a1i/archify -g\n' +
    'Or point `archify.bin` in contrail.config.ts at an existing checkout.'
  )
}

async function invoke(
  runner: ArchifyRunner,
  args: string[],
  bin: string,
): Promise<{ stdout: string; code: number }> {
  try {
    return await runner(args)
  } catch (error) {
    if (isEnoent(error)) throw new Error(enoentMessage(bin))
    throw error
  }
}

/** Extracts the CLI's own message from a `--json` failure payload, falling back to raw output. */
function cliErrorMessage(stdout: string): string {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error
    }
  } catch {
    // not JSON — fall through to raw output
  }
  return stdout.trim()
}

export function archifyHash(irContents: string | Buffer): string {
  return createHash('sha256').update(irContents).digest('hex')
}

export async function validateArchify(
  type: ArchifyType,
  irPath: string,
  opts: ArchifyOptions = {},
): Promise<void> {
  const runner = runnerFor(opts)
  const { stdout, code } = await invoke(runner, ['validate', type, irPath, '--json'], binFor(opts))
  if (code !== 0) {
    throw new ArchifyValidationError(cliErrorMessage(stdout))
  }
}

export async function renderArchify(
  type: ArchifyType,
  irPath: string,
  cacheDir: string,
  opts: ArchifyOptions = {},
): Promise<RenderedArchify> {
  const hash = archifyHash(readFileSync(irPath))
  const dir = join(cacheDir, 'archify')
  mkdirSync(dir, { recursive: true })

  const htmlPath = join(dir, `${hash}.html`)
  if (existsSync(htmlPath)) return { hash, htmlPath, irPath }

  const runner = runnerFor(opts)
  const { stdout, code } = await invoke(runner, ['render', type, irPath, htmlPath], binFor(opts))
  if (code !== 0) {
    throw new ArchifyValidationError(cliErrorMessage(stdout))
  }
  return { hash, htmlPath, irPath }
}
