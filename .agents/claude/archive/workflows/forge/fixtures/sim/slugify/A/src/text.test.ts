import { expect, test } from 'bun:test'
import { capitalize, slugify } from './text'

test('capitalize uppercases the first letter', () => {
  expect(capitalize('rust')).toBe('Rust')
})

test('S1.1 slugify lowercases and joins words with hyphens', () => {
  expect(slugify('Hello World')).toBe('hello-world')
})

test('S1.2 slugify collapses runs of non-alphanumerics into one hyphen', () => {
  expect(slugify('C++ & Rust')).toBe('c-rust')
})

test('S1.3 slugify leaves no leading or trailing hyphen', () => {
  expect(slugify('  Hello  ')).toBe('hello')
})
