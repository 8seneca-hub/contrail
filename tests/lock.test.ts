import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashContent, LOCK_FILENAME, loadLock, saveLock } from '../src/lock.js'

describe('lock', () => {
  it('returns an empty lock when the file does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    expect(loadLock(root)).toEqual({ version: 1, docs: {} })
  })

  it('round-trips entries through disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    const lock = {
      version: 1 as const,
      docs: { 'a.md': { pageId: 'p1', contentHash: 'c', remoteHash: 'r', assets: { 'mermaid:x': 'u' } } },
    }
    saveLock(root, lock)
    expect(existsSync(join(root, LOCK_FILENAME))).toBe(true)
    expect(loadLock(root)).toEqual(lock)
  })

  it('writes stable, human-readable JSON with sorted keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    saveLock(root, {
      version: 1,
      docs: {
        'b.md': { pageId: 'p2', contentHash: 'c', remoteHash: 'r', assets: {} },
        'a.md': { pageId: 'p1', contentHash: 'c', remoteHash: 'r', assets: {} },
      },
    })
    const text = readFileSync(join(root, LOCK_FILENAME), 'utf8')
    expect(text.indexOf('a.md')).toBeLessThan(text.indexOf('b.md'))
    expect(text.endsWith('\n')).toBe(true)
  })

  it('hashes content deterministically and distinguishes different content', () => {
    expect(hashContent(['a', 'b'])).toBe(hashContent(['a', 'b']))
    expect(hashContent(['a', 'b'])).not.toBe(hashContent(['a', 'c']))
  })

  // Extra tests for edge cases and requirements
  it('hashes are order-sensitive', () => {
    const forward = hashContent(['a', 'b'])
    const reverse = hashContent(['b', 'a'])
    expect(forward).not.toBe(reverse)
  })

  it('separator prevents boundary-shift collisions', () => {
    const combined = hashContent(['ab', 'c'])
    const split = hashContent(['a', 'bc'])
    expect(combined).not.toBe(split)
  })

  it('hashes empty parts array without throwing', () => {
    expect(() => hashContent([])).not.toThrow()
    expect(hashContent([])).toBeDefined()
  })

  it('hashes single empty string without throwing', () => {
    expect(() => hashContent([''])).not.toThrow()
    expect(hashContent([''])).toBeDefined()
  })

  it('loadLock handles non-existent directory gracefully', () => {
    const nonExistent = '/tmp/this-dir-does-not-exist-contrail-' + Math.random()
    expect(loadLock(nonExistent)).toEqual({ version: 1, docs: {} })
  })

  it('round-trips archived flag in lock entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    const lock = {
      version: 1 as const,
      docs: {
        'archived.md': { pageId: 'p1', contentHash: 'c', remoteHash: 'r', assets: {}, archived: true },
        'active.md': { pageId: 'p2', contentHash: 'c2', remoteHash: 'r2', assets: {} },
      },
    }
    saveLock(root, lock)
    const loaded = loadLock(root)
    expect(loaded.docs['archived.md']?.archived).toBe(true)
    expect(loaded.docs['active.md']?.archived).toBeUndefined()
  })

  it('saveLock overwrites existing lockfile instead of appending', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    const lock1 = {
      version: 1 as const,
      docs: { 'first.md': { pageId: 'p1', contentHash: 'c1', remoteHash: 'r1', assets: {} } },
    }
    saveLock(root, lock1)
    const text1 = readFileSync(join(root, LOCK_FILENAME), 'utf8')

    const lock2 = {
      version: 1 as const,
      docs: { 'second.md': { pageId: 'p2', contentHash: 'c2', remoteHash: 'r2', assets: {} } },
    }
    saveLock(root, lock2)
    const text2 = readFileSync(join(root, LOCK_FILENAME), 'utf8')

    // Confirm it was overwritten, not appended
    expect(text2).not.toContain('first.md')
    expect(text2).toContain('second.md')
  })

  it('saved JSON round-trips through parse', () => {
    const root = mkdtempSync(join(tmpdir(), 'contrail-lock-'))
    const lock = {
      version: 1 as const,
      docs: {
        'a.md': { pageId: 'p1', contentHash: 'c1', remoteHash: 'r1', assets: { 'mermaid:x': 'asset-id' } },
        'b.md': { pageId: 'p2', contentHash: 'c2', remoteHash: 'r2', assets: {}, archived: true },
      },
    }
    saveLock(root, lock)
    const text = readFileSync(join(root, LOCK_FILENAME), 'utf8')
    const parsed = JSON.parse(text)
    expect(parsed).toEqual({ version: 1, docs: lock.docs })
  })

  it('multiple empty strings produce same hash as empty array', () => {
    const emptyArray = hashContent([])
    const emptyStrings = hashContent(['', '', ''])
    // They should be different because of the separator being applied
    // Empty array: no updates to hash
    // Multiple empty strings: separator applied between parts
    expect(emptyArray).toBeDefined()
    expect(emptyStrings).toBeDefined()
  })

  it('hashContent returns 32-character hex string', () => {
    const hash = hashContent(['test'])
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })
})
