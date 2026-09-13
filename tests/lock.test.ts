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

  it('length-prefix prevents literal separator ambiguity in content', () => {
    // Real case: doc.body contains a line with '--', causing collision with old separator
    const separated = hashContent(['body-X', 'asset-Y'])
    const merged = hashContent(['body-X\n--\nasset-Y'])
    expect(separated).not.toBe(merged)
  })

  it('handles multi-byte UTF-8 characters at part boundaries', () => {
    // Emoji (4 bytes in UTF-8): test that byte length, not string length, prevents collisions
    const emojiSplit = hashContent(['🎯-part', 'two'])
    const emojiMerged = hashContent(['🎯-parttwo'])
    expect(emojiSplit).not.toBe(emojiMerged)

    // Accented character (2 bytes in UTF-8)
    const accentSplit = hashContent(['café', 'au'])
    const accentMerged = hashContent(['caféau'])
    expect(accentSplit).not.toBe(accentMerged)
  })

  it('hashes empty parts array, single empty string, and multiple empty strings all differently', () => {
    const emptyArray = hashContent([])
    const singleEmpty = hashContent([''])
    const multiEmpty = hashContent(['', '', ''])

    // All must be deterministic 32-char hex strings
    expect(emptyArray).toMatch(/^[0-9a-f]{32}$/)
    expect(singleEmpty).toMatch(/^[0-9a-f]{32}$/)
    expect(multiEmpty).toMatch(/^[0-9a-f]{32}$/)

    // All must be different from each other
    expect(emptyArray).not.toBe(singleEmpty)
    expect(emptyArray).not.toBe(multiEmpty)
    expect(singleEmpty).not.toBe(multiEmpty)

    // Verify determinism
    expect(hashContent([])).toBe(emptyArray)
    expect(hashContent([''])).toBe(singleEmpty)
    expect(hashContent(['', '', ''])).toBe(multiEmpty)
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

})
