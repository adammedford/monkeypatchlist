import { describe, expect, test } from 'vitest'
import { greet } from '../index.ts'

describe('example package', () => {
  test('greets through its entry point', () => {
    expect(greet('monkeypatchlist')).toBe('Hello, monkeypatchlist!')
  })

  test('greets the world when the name is blank', () => {
    expect(greet('  ')).toBe('Hello, world!')
  })
})
