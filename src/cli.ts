import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { globSync } from 'tinyglobby'
import { findConfigPath, loadConfig } from './config.js'
import { loadLock, saveLock } from './lock.js'
import { parseDoc } from './parse.js'
import { PlaneClient } from './plane/client.js'
import { publishDocs, type PublishResult } from './plane/publish.js'
import type { Config, Doc } from './types.js'

const TEMPLATE = `export default {
  plane: {
    baseUrl: 'https://plane.example.com',
    workspace: 'your-workspace-slug',
  },
  repos: {},
  docs: ['./docs/**/*.md', './*/docs/**/*.md'],
}
`

export function runInit(cwd: string): string {
  const path = join(cwd, 'contrail.config.ts')
  if (existsSync(path)) throw new Error(`${path} already exists.`)
  writeFileSync(path, TEMPLATE)
  return path
}

export function findDocs(config: Config): string[] {
  return globSync(config.docs, { cwd: config.root, absolute: true }).sort()
}

/** Blocked documents mean someone's edit in Plane would be discarded; that must never look like success. */
export function exitCodeFor(result: PublishResult): number {
  return result.blocked.length > 0 ? 1 : 0
}

/** The one `--only` filter predicate. Every command narrows via this, never a reimplementation of it. */
export function filterByOnly(docs: Doc[], only: string | undefined): Doc[] {
  return docs.filter((doc) => !only || doc.key.includes(only))
}

/**
 * Assembles the `docs`/`knownKeys` pair for `publishDocs`. `docs` is what
 * `--only` narrows to publish; `knownKeys` is always the FULL set of document
 * keys found on disk, regardless of `--only`. The archive sweep in
 * `publishDocs` must reason about `knownKeys`, never the filtered `docs` —
 * otherwise `--only` (or a no-match filter) archives every unrelated page.
 */
export function publishArgsFor(
  allDocs: Doc[],
  only: string | undefined,
): { docs: Doc[]; knownKeys: string[] } {
  return { docs: filterByOnly(allDocs, only), knownKeys: allDocs.map((doc) => doc.key) }
}

/** The blocked-document safety warning. Names the document and warns that `--force` discards its edit. */
export function blockedMessageFor(key: string): string[] {
  return [
    `BLOCKED  ${key} was edited in Plane since the last publish; nothing was written.`,
    '         Re-publish with --force only if that edit can be discarded.',
  ]
}

function requireApiKey(): string {
  const key = process.env.PLANE_API_KEY
  if (!key) {
    throw new Error('PLANE_API_KEY is not set. Export it; it must never be stored in a config file.')
  }
  return key
}

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      only: { type: 'string' },
    },
  })

  const command = positionals[0] ?? 'help'

  if (command === 'help') {
    console.log('contrail init | build | status | publish [--dry-run] [--force] [--only <substring>]')
    return 0
  }

  if (command === 'init') {
    console.log(`Created ${runInit(process.cwd())}`)
    return 0
  }

  const config = loadConfig(findConfigPath(process.cwd()))
  const allDocs = findDocs(config).map((path) => parseDoc(path, config.root))
  const { docs, knownKeys } = publishArgsFor(allDocs, values.only)

  if (command === 'build') {
    console.log(`${docs.length} document(s) parsed with no errors.`)
    return 0
  }

  if (command === 'status') {
    const lock = loadLock(config.root)
    for (const doc of docs) {
      const entry = lock.docs[doc.key]
      console.log(`${entry?.pageId ?? 'unpublished'}  ${doc.frontmatter.status.padEnd(8)}  ${doc.key}`)
    }
    return 0
  }

  if (command === 'publish') {
    const lock = loadLock(config.root)
    const client = new PlaneClient({
      baseUrl: config.plane.baseUrl,
      workspace: config.plane.workspace,
      apiKey: requireApiKey(),
    })

    const result = await publishDocs({
      config,
      docs,
      client,
      lock,
      cacheDir: join(config.root, '.contrail', 'cache'),
      knownKeys,
      options: { dryRun: values['dry-run'], force: values.force },
    })

    if (!values['dry-run']) saveLock(config.root, lock)

    console.log(
      `created ${result.created.length}, updated ${result.updated.length}, ` +
        `skipped ${result.skipped.length}, archived ${result.archived.length}`,
    )
    for (const key of result.blocked) {
      for (const line of blockedMessageFor(key)) console.error(line)
    }
    return exitCodeFor(result)
  }

  console.error(`Unknown command: ${command}`)
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
