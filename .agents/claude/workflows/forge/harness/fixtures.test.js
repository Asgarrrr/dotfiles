import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRepo } from './repo.js'
import { SIM_DIR } from './fakes.js'

const apply = (repo, sim, ...variants) => variants.forEach(v => cpSync(join(SIM_DIR, sim, v), repo, { recursive: true }))

// name -> 'pass' | 'fail'; a test absent from the map was not collected.
function junit(repo, paths = '') {
  const out = join(mkdtempSync(join(tmpdir(), 'forge-junit-')), 'r.xml')
  spawnSync('bash', ['-c', `bun test ${paths} --reporter=junit --reporter-outfile=${out}`], { cwd: repo })
  const cases = {}
  const xml = readFileSync(out, 'utf8')
  for (const m of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    cases[m[1]] = m[2] && m[2].includes('<failure') ? 'fail' : 'pass'
  }
  return cases
}

const S1 = [
  'S1.1 slugify lowercases and joins words with hyphens',
  'S1.2 slugify collapses runs of non-alphanumerics into one hyphen',
  'S1.3 slugify leaves no leading or trailing hyphen',
]
const V1 = 'b1 v1: trailing punctuation leaves no trailing hyphen'
const V2 = 'b1 v2: surrounding punctuation leaves no hyphen'

describe('slugify fixture', () => {
  test('at A the clause tests fail on the stub and capitalize still passes', () => {
    const repo = makeRepo('app'); apply(repo, 'slugify', 'A')
    const r = junit(repo)
    for (const name of S1) expect(r[name]).toBe('fail')
    expect(r['capitalize uppercases the first letter']).toBe('pass')
  })

  test('builder-A.json line ranges point at the named tests', () => {
    const map = JSON.parse(readFileSync(join(SIM_DIR, 'slugify', 'builder-A.json'), 'utf8'))
    const lines = readFileSync(join(SIM_DIR, 'slugify', 'A', 'src', 'text.test.ts'), 'utf8').split('\n')
    for (const t of map.tests) expect(lines[t.lines[0] - 1]).toContain(t.name)
    expect(map.tests.map(t => t.clause)).toEqual(['S1.1', 'S1.2', 'S1.3'])
  })

  test('at B every test passes', () => {
    const repo = makeRepo('app'); apply(repo, 'slugify', 'A', 'B')
    const r = junit(repo)
    expect(Object.keys(r).length).toBeGreaterThan(0)
    expect(Object.values(r).every(v => v === 'pass')).toBe(true)
  })

  test('B-buggy passes every clause test but fails both planted red variants', () => {
    const repo = makeRepo('app'); apply(repo, 'slugify', 'A', 'B-buggy', 'red-planted')
    const r = junit(repo)
    for (const name of S1) expect(r[name]).toBe('pass')
    expect(r[V1]).toBe('fail')
    expect(r[V2]).toBe('fail')
  })

  test('blue-fix passes both variants; blue-specialcase passes only the visible one', () => {
    const fixed = makeRepo('app'); apply(fixed, 'slugify', 'A', 'B-buggy', 'red-planted', 'blue-fix')
    const f = junit(fixed)
    expect([f[V1], f[V2]]).toEqual(['pass', 'pass'])
    const special = makeRepo('app'); apply(special, 'slugify', 'A', 'B-buggy', 'red-planted', 'blue-specialcase')
    const s = junit(special)
    expect([s[V1], s[V2]]).toEqual(['pass', 'fail'])
  })

  test('blue-tamper makes variant 1 pass by editing the red test itself', () => {
    const repo = makeRepo('app'); apply(repo, 'slugify', 'A', 'B-buggy', 'red-planted', 'blue-tamper')
    const r = junit(repo)
    expect(r[V1]).toBe('pass')
    expect(r[V2]).toBe('fail')
  })

  test('the restating red tests fail at a correct B (their oracle is wrong)', () => {
    const repo = makeRepo('app'); apply(repo, 'slugify', 'A', 'B', 'red-restating')
    const r = junit(repo)
    expect(r['b1 v1: words join with underscores']).toBe('fail')
    expect(r['b1 v2: words join with underscores, again']).toBe('fail')
  })
})
