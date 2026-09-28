import { expect, test } from 'bun:test'
import { capitalize } from './text'

test('capitalize uppercases the first letter', () => {
  expect(capitalize('rust')).toBe('Rust')
})
