import { expect, test } from 'bun:test'
import { exportReport } from './export'

test('admin receives the CSV report', () => {
  expect(exportReport({ id: 'u1', role: 'admin' })).toEqual({ status: 200, body: 'id,total\n1,100\n' })
})
