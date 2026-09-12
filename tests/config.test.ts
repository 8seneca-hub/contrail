import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, findConfigPath, loadConfig } from '../src/config.js'

function workspace(config: string): string {
  const root = mkdtempSync(join(tmpdir(), 'contrail-'))
  writeFileSync(join(root, 'contrail.config.json'), config)
  mkdirSync(join(root, 'repo-a', 'docs'), { recursive: true })
  return root
}

const VALID = JSON.stringify({
  plane: { baseUrl: 'https://plane.example.com', workspace: 'acme' },
  repos: { a: './repo-a' },
  docs: ['./docs/**/*.md'],
})

describe('findConfigPath', () => {
  it('finds the config by walking up from a nested directory', () => {
    const root = workspace(VALID)
    expect(findConfigPath(join(root, 'repo-a', 'docs'))).toBe(join(root, 'contrail.config.json'))
  })

  it('throws a message naming the directory when no config exists', () => {
    const empty = mkdtempSync(join(tmpdir(), 'contrail-empty-'))
    expect(() => findConfigPath(empty)).toThrow(/No contrail\.config/)
  })
})

describe('loadConfig', () => {
  it('returns the config with root set to the config directory', () => {
    const root = workspace(VALID)
    const cfg = loadConfig(join(root, 'contrail.config.json'))
    expect(cfg.root).toBe(root)
    expect(cfg.plane.workspace).toBe('acme')
  })

  it('rejects a config missing plane.workspace', () => {
    const root = workspace(JSON.stringify({ plane: { baseUrl: 'https://x' }, docs: ['./d/*.md'] }))
    expect(() => loadConfig(join(root, 'contrail.config.json'))).toThrow(ConfigError)
  })

  it('rejects docs entries that are not strings', () => {
    const root = workspace(JSON.stringify({
      plane: { baseUrl: 'https://plane.example.com', workspace: 'acme' },
      docs: ['./docs/**/*.md', 123],
    }))
    expect(() => loadConfig(join(root, 'contrail.config.json'))).toThrow(/docs\[1\].*must be a non-empty string/)
  })

  it('rejects repos values that are not strings', () => {
    const root = workspace(JSON.stringify({
      plane: { baseUrl: 'https://plane.example.com', workspace: 'acme' },
      repos: { a: './repo-a', billing: 5 },
      docs: ['./docs/**/*.md'],
    }))
    expect(() => loadConfig(join(root, 'contrail.config.json'))).toThrow(/repos\.billing.*must be a string/)
  })

  it('accepts a config with no archify field', () => {
    const root = workspace(VALID)
    const cfg = loadConfig(join(root, 'contrail.config.json'))
    expect(cfg.archify).toBeUndefined()
  })

  it('accepts an archify.bin absolute path', () => {
    const root = workspace(JSON.stringify({
      plane: { baseUrl: 'https://plane.example.com', workspace: 'acme' },
      docs: ['./docs/**/*.md'],
      archify: { bin: '/opt/archify/bin/archify.mjs' },
    }))
    const cfg = loadConfig(join(root, 'contrail.config.json'))
    expect(cfg.archify).toEqual({ bin: '/opt/archify/bin/archify.mjs' })
  })

  it('accepts archify as an empty object (bin resolved from PATH)', () => {
    const root = workspace(JSON.stringify({
      plane: { baseUrl: 'https://plane.example.com', workspace: 'acme' },
      docs: ['./docs/**/*.md'],
      archify: {},
    }))
    const cfg = loadConfig(join(root, 'contrail.config.json'))
    expect(cfg.archify).toEqual({})
  })

  it('rejects archify.bin that is not a string', () => {
    const root = workspace(JSON.stringify({
      plane: { baseUrl: 'https://plane.example.com', workspace: 'acme' },
      docs: ['./docs/**/*.md'],
      archify: { bin: 123 },
    }))
    expect(() => loadConfig(join(root, 'contrail.config.json'))).toThrow(/archify\.bin.*must be a string/)
  })

  it('rejects archify that is not an object', () => {
    const root = workspace(JSON.stringify({
      plane: { baseUrl: 'https://plane.example.com', workspace: 'acme' },
      docs: ['./docs/**/*.md'],
      archify: 'nope',
    }))
    expect(() => loadConfig(join(root, 'contrail.config.json'))).toThrow(/archify.*must be an object/)
  })
})
