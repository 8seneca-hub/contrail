import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Lock, LockEntry } from './types.js'

export const LOCK_FILENAME = 'contrail.lock.json'

export function hashContent(parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\n--\n')
  return hash.digest('hex').slice(0, 32)
}

export function loadLock(root: string): Lock {
  const path = join(root, LOCK_FILENAME)
  if (!existsSync(path)) return { version: 1, docs: {} }
  return JSON.parse(readFileSync(path, 'utf8')) as Lock
}

export function saveLock(root: string, lock: Lock): void {
  const docs: Record<string, LockEntry> = {}
  for (const key of Object.keys(lock.docs).sort()) docs[key] = lock.docs[key]!
  writeFileSync(join(root, LOCK_FILENAME), `${JSON.stringify({ version: 1, docs }, null, 2)}\n`)
}
