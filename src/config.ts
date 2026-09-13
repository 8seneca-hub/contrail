import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import type { Config } from './types.js'

const CONFIG_NAMES = ['contrail.config.ts', 'contrail.config.js', 'contrail.config.json']

export class ConfigError extends Error {}

export function findConfigPath(startDir: string): string {
  let dir = resolve(startDir)
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new ConfigError(
        `No contrail.config.{ts,js,json} found in ${startDir} or any parent directory. ` +
          'Run `contrail init` at the root of your workspace to create one.',
      )
    }
    dir = parent
  }
}

export function loadConfig(configPath: string): Config {
  const jiti = createJiti(configPath, { interopDefault: true })
  const raw = jiti(configPath) as Partial<Config>

  if (!raw.plane?.baseUrl) throw new ConfigError(`${configPath}: \`plane.baseUrl\` is required.`)
  if (!raw.plane?.workspace) throw new ConfigError(`${configPath}: \`plane.workspace\` is required.`)
  if (!Array.isArray(raw.docs) || raw.docs.length === 0) {
    throw new ConfigError(`${configPath}: \`docs\` must be a non-empty array of globs.`)
  }

  // Validate docs entries are non-empty strings
  for (let i = 0; i < raw.docs.length; i++) {
    const doc = raw.docs[i]
    if (typeof doc !== 'string' || doc.length === 0) {
      throw new ConfigError(`${configPath}: \`docs[${i}]\` must be a non-empty string.`)
    }
  }

  // Validate repos values are strings
  const repos = raw.repos ?? {}
  for (const [key, value] of Object.entries(repos)) {
    if (typeof value !== 'string') {
      throw new ConfigError(`${configPath}: \`repos.${key}\` must be a string.`)
    }
  }

  if (raw.archify !== undefined) {
    if (typeof raw.archify !== 'object' || raw.archify === null) {
      throw new ConfigError(`${configPath}: \`archify\` must be an object.`)
    }
    if (raw.archify.bin !== undefined && typeof raw.archify.bin !== 'string') {
      throw new ConfigError(`${configPath}: \`archify.bin\` must be a string.`)
    }
  }

  if (raw.sheets !== undefined) {
    if (typeof raw.sheets !== 'object' || raw.sheets === null) {
      throw new ConfigError(`${configPath}: \`sheets\` must be an object.`)
    }
    if (raw.sheets.credentialsPath !== undefined && typeof raw.sheets.credentialsPath !== 'string') {
      throw new ConfigError(`${configPath}: \`sheets.credentialsPath\` must be a string.`)
    }
  }

  if (raw.site !== undefined) {
    if (typeof raw.site !== 'object' || raw.site === null) {
      throw new ConfigError(`${configPath}: \`site\` must be an object.`)
    }
    for (const key of ['internalUrl', 'clientUrl'] as const) {
      if (raw.site[key] !== undefined && typeof raw.site[key] !== 'string') {
        throw new ConfigError(`${configPath}: \`site.${key}\` must be a string.`)
      }
    }
  }

  // Trailing slashes are stripped once here so every consumer (llms.txt,
  // canonical tags) can join with `/${path}` without worrying about `//`.
  const site = raw.site && {
    ...raw.site,
    internalUrl: raw.site.internalUrl?.replace(/\/+$/, ''),
    clientUrl: raw.site.clientUrl?.replace(/\/+$/, ''),
  }

  if (raw.vercel !== undefined) {
    if (typeof raw.vercel !== 'object' || raw.vercel === null) {
      throw new ConfigError(`${configPath}: \`vercel\` must be an object.`)
    }
    for (const key of ['internalProject', 'clientProject'] as const) {
      if (raw.vercel[key] !== undefined && typeof raw.vercel[key] !== 'string') {
        throw new ConfigError(`${configPath}: \`vercel.${key}\` must be a string.`)
      }
    }
  }

  // Shape only — the business rules (slug pattern, internalPath !== clientPath) are deploy-time
  // guards in src/deploy.ts, the same split as `vercel` above (config.ts checks types; deploy.ts
  // checks that a build can't land somewhere it shouldn't).
  if (raw.selfhost !== undefined) {
    if (typeof raw.selfhost !== 'object' || raw.selfhost === null) {
      throw new ConfigError(`${configPath}: \`selfhost\` must be an object.`)
    }
    if (raw.selfhost.target !== 'railway' && raw.selfhost.target !== 'plane') {
      throw new ConfigError(`${configPath}: \`selfhost.target\` must be 'plane' or 'railway'.`)
    }
    const fields = raw.selfhost as unknown as Record<string, unknown>
    const required =
      raw.selfhost.target === 'plane'
        ? ['projectId']
        : ['volume', 'slug', 'internalPath', 'clientPath']
    for (const key of required) {
      const value = fields[key]
      if (typeof value !== 'string' || value.length === 0) {
        throw new ConfigError(`${configPath}: \`selfhost.${key}\` must be a non-empty string.`)
      }
    }
    if (raw.selfhost.target === 'railway' && raw.selfhost.service !== undefined && typeof raw.selfhost.service !== 'string') {
      throw new ConfigError(`${configPath}: \`selfhost.service\` must be a string.`)
    }
  }

  return {
    root: dirname(configPath),
    plane: {
      baseUrl: raw.plane.baseUrl.replace(/\/+$/, ''),
      workspace: raw.plane.workspace,
      collection: raw.plane.collection,
    },
    repos,
    docs: raw.docs,
    site,
    vercel: raw.vercel,
    archify: raw.archify,
    sheets: raw.sheets,
    selfhost: raw.selfhost,
  }
}

export interface ProjectMeta {
  client: string
  project: string
  startDate: string
}

const PROJECT_META_KEYS = ['client', 'project', 'startDate'] as const

/**
 * Reads `docs/00-meta/project.yml` — written by `runInitTemplate` in
 * scaffold.ts and, until now, never read by anything. Only the three
 * fields `renderProjectYml` ever writes: no general YAML parsing, since
 * the file's shape is entirely owned by that one writer. Returns
 * `undefined` when the file is absent — most trees, and most test
 * fixtures, will not have one — so callers must fall back sensibly
 * rather than treat a missing file as an error.
 */
export function readProjectMeta(root: string): ProjectMeta | undefined {
  const path = join(root, 'docs', '00-meta', 'project.yml')
  if (!existsSync(path)) return undefined

  const values: Partial<Record<(typeof PROJECT_META_KEYS)[number], string>> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^(client|project|startDate):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const key = match[1] as (typeof PROJECT_META_KEYS)[number]
    const rawValue = match[2]!
    values[key] = rawValue.startsWith('"') ? (JSON.parse(rawValue) as string) : rawValue
  }

  if (!values.client || !values.project || !values.startDate) return undefined
  return { client: values.client, project: values.project, startDate: values.startDate }
}
