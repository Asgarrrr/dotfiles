import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { makeRepo, git } from './repo.js'

describe('repo', () => {
  test('makeRepo commits the fixture app as "base" on main, with a clean tree', () => {
    const repo = makeRepo('app')
    expect(git(repo, 'log -1 --format=%s')).toBe('base')
    expect(git(repo, 'branch --show-current')).toBe('main')
    expect(git(repo, 'status --porcelain')).toBe('')
  })

  test('the fixture app suite is green at base', () => {
    const repo = makeRepo('app')
    const r = spawnSync('bun', ['test'], { cwd: repo, encoding: 'utf8' })
    expect(r.status).toBe(0)
  })
})
