import { existsSync } from 'node:fs'
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

  return {
    root: dirname(configPath),
    plane: {
      baseUrl: raw.plane.baseUrl.replace(/\/+$/, ''),
      workspace: raw.plane.workspace,
      collection: raw.plane.collection,
    },
    repos,
    docs: raw.docs,
    site: raw.site,
    archify: raw.archify,
    sheets: raw.sheets,
  }
}
