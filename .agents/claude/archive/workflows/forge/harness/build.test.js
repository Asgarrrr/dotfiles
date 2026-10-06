import { expect, test } from 'bun:test'
import { stale } from '../build.js'

test('every built workflow matches its source (run `bun build.js`)', () => {
  expect(stale()).toEqual([])
})
