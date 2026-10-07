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
