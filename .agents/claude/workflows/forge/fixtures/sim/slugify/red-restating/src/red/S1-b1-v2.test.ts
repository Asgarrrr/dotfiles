import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v2: words join with underscores, again', () => {
  expect(slugify('Big Cat')).toBe('big_cat')
})
