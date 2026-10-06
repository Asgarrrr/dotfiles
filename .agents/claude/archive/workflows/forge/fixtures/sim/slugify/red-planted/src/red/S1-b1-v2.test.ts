import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v2: surrounding punctuation leaves no hyphen', () => {
  expect(slugify('?Rust?')).toBe('rust')
})
