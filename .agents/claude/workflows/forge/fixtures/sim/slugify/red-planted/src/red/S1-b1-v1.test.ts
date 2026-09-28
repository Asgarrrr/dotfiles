import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v1: trailing punctuation leaves no trailing hyphen', () => {
  expect(slugify('Hello!')).toBe('hello')
})
