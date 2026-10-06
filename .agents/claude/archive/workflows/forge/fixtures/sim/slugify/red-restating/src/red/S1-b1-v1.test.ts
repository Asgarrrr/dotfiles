import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v1: words join with underscores', () => {
  expect(slugify('Hello World')).toBe('hello_world')
})
