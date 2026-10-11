import { describe, expect, it } from 'vitest'
import { greet } from '../src/greet.js'

describe('greet', () => {
  it('greets a normal name', () => {
    expect(greet('Ada')).toBe('Hello, Ada!')
  })

  it('interpolates an empty name plainly, with no fallback', () => {
    expect(greet('')).toBe('Hello, !')
  })
})
