import { afterEach, describe, expect, it, vi } from 'vitest'
import { greet } from '../src/greet.js'
import { main } from '../src/cli.js'

describe('greet', () => {
  it('greets a name', () => {
    expect(greet('Ada')).toBe('Hello, Ada!')
  })

  it('interpolates an empty string rather than judging it', () => {
    expect(greet('')).toBe('Hello, !')
  })
})

describe('greet command (via main)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the greeting and exits 0', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg)
    })
    expect(await main(['greet', 'Ada'])).toBe(0)
    expect(logs).toContain('Hello, Ada!')
  })

  it('exits 2 with a usage line when the name is missing', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(msg)
    })
    expect(await main(['greet'])).toBe(2)
    expect(errors).toContain('Usage: contrail greet <name>')
  })
})
