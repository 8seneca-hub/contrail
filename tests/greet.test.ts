import { describe, expect, it } from 'vitest'
import { greet } from '../src/greet.js'

describe('greet', () => {
  it('returns the greeting for an ordinary name', () => {
    expect(greet('Ada')).toBe('Hello, Ada!')
  })

  it('returns the greeting for an empty string — no validation', () => {
    expect(greet('')).toBe('Hello, !')
  })
})
