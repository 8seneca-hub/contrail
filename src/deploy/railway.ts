import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DeployError, type CliRunner } from '../deploy.js'
import type { DeployTransport } from './transport.js'

export interface RailwayTransportOptions {
  /** Volume ID or name. Railway's `-v/--volume` flag on `railway volume files` must be passed
   * before the `upload` subcommand — see https://docs.railway.com/cli/volume. */
  volume: string
  /** Optional service scope, Railway's `-s/--service` — needed only when a volume name is
   * ambiguous across services. */
  service?: string
}

/** Every file under `dir`, counted recursively — used only to report `filesSent` for both a real
 * push (before Railway's own upload progress takes over stdout) and a `--dry-run` report. Mirrors
 * `countFiles` in `src/deploy.ts`; kept local so this module has no import cycle back to it beyond
 * the `CliRunner` type and `DeployError`. */
function countFilesRecursive(dir: string): number {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    count += entry.isDirectory() ? countFilesRecursive(path) : 1
  }
  return count
}

function uploadCommand(opts: RailwayTransportOptions, localDir: string, remotePath: string): string[] {
  const args = ['volume', 'files', '--volume', opts.volume]
  if (opts.service) args.push('--service', opts.service)
  args.push('upload', localDir, remotePath, '--overwrite', '--concurrency', '32')
  return args
}

/**
 * Shells out to the Railway CLI's `railway volume files upload`. The Railway CLI owns
 * authentication entirely — contrail never reads, stores, or logs a Railway token. `runner` is
 * injected (see `CliRunner` in `src/deploy.ts`); tests must never invoke the real `railway` binary.
 */
export function createRailwayTransport(runner: CliRunner, opts: RailwayTransportOptions): DeployTransport {
  return {
    name: 'railway',
    async push(localDir, remotePath, pushOpts) {
      const command = uploadCommand(opts, localDir, remotePath)
      const filesSent = countFilesRecursive(localDir)

      if (pushOpts.dryRun) {
        console.log(`Would upload ${filesSent} file(s) from ${localDir} to ${remotePath}`)
        console.log(`Would run: railway ${command.join(' ')}`)
        return { filesSent }
      }

      const result = await runner('railway', command)
      if (result.code !== 0) {
        throw new DeployError(`railway exited with code ${result.code}.`)
      }
      return { filesSent }
    },
  }
}
