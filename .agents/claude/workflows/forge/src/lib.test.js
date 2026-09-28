import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  sha256, parseJunit, outcomes, checkPlan, sizeOf, riskOf, raiseTier, dosing,
  parsePorcelain, isProtected, q, ledgerLine, paths, junitCommand, parseDismiss,
} from './lib.js'

const nodeSha = s => createHash('sha256').update(s, 'utf8').digest('hex')

describe('sha256', () => {
  // 55/56/63/64 bytes straddle the padding boundary where a length word spills
  // into a second block — the classic hand-rolled SHA bug.
  const inputs = ['', 'abc', 'é🙂\n"quoted"', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'x'.repeat(1000)]
  for (const s of inputs) test(`matches node crypto for length ${s.length}`, () => expect(sha256(s)).toBe(nodeSha(s)))
})

const BUN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3">
  <testsuite name="src/a.test.ts" file="src/a.test.ts" tests="3">
    <testcase name="a &amp; b &quot;q&quot;" classname="" time="0.1" file="src/a.test.ts" line="2" assertions="1">
      <failure type="AssertionError" message="x&#10;y">AssertionError: x</failure>
    </testcase>
    <testcase name="thrown" classname="" file="src/a.test.ts" line="3">
      <failure type="Error" message="not implemented">Error</failure>
    </testcase>
    <testcase name="ok" classname="" file="./src/a.test.ts" line="4" assertions="1" />
  </testsuite>
</testsuites>`

describe('parseJunit', () => {
  test('reads names with escapes, outcomes, failure types and normalized files', () => {
    expect(parseJunit(BUN_XML)).toEqual([
      { name: 'a & b "q"', file: 'src/a.test.ts', outcome: 'fail', failureType: 'AssertionError' },
      { name: 'thrown', file: 'src/a.test.ts', outcome: 'fail', failureType: 'Error' },
      { name: 'ok', file: 'src/a.test.ts', outcome: 'pass', failureType: null },
    ])
  })

  test('reads the grep stream the runner returns', () => {
    const stream = BUN_XML.match(/<testcase [^>]*>|<\/testcase>|<failure type="[^"]*"/g).join('\n')
    expect(parseJunit(stream)).toEqual(parseJunit(BUN_XML))
  })

  test('outcomes marks a test absent from the report as not-collected', () => {
    const cases = parseJunit(BUN_XML)
    expect(outcomes([{ file: 'src/a.test.ts', name: 'ok' }, { file: 'src/a.test.ts', name: 'gone' }], cases))
      .toEqual(['pass', 'not-collected'])
  })
})

const clause = (id, kind, extra = {}) => ({ id, kind, input: 'i', action: 'a', expected: 'e', source: 'task', ...extra })
const plan = spec => ({ slices: [{ id: 'S1', title: 't', files: ['a.ts'], spec }], rejected: [] })

describe('checkPlan', () => {
  test('accepts a well-formed plan with no signals', () => {
    expect(checkPlan(plan([clause('S1.1', 'behavior')]), { signals: [] })).toEqual([])
  })

  test('an auth signal requires a negative clause in every slice', () => {
    const problems = checkPlan(plan([clause('S1.1', 'behavior')]), { signals: [{ id: 'auth' }] })
    expect(problems.join('\n')).toContain('S1: signal auth needs a negative clause')
    expect(checkPlan(plan([clause('S1.1', 'negative')]), { signals: [{ id: 'auth' }] })).toEqual([])
  })

  test('persistence accepts migration or negative', () => {
    expect(checkPlan(plan([clause('S1.1', 'migration')]), { signals: [{ id: 'persistence' }] })).toEqual([])
    expect(checkPlan(plan([clause('S1.1', 'behavior')]), { signals: [{ id: 'persistence' }] })).toHaveLength(1)
  })

  test('flags empty fields, unknown kinds, duplicate ids and an empty plan', () => {
    const p = plan([clause('S1.1', 'behavior', { expected: ' ' }), clause('S1.1', 'vibes')])
    const text = checkPlan(p, { signals: [] }).join('\n')
    expect(text).toContain('S1.1: empty expected')
    expect(text).toContain('S1.1: unknown kind vibes')
    expect(text).toContain('duplicate clause id S1.1')
    expect(checkPlan({ slices: [] }, { signals: [] })).toEqual(['plan has no slices'])
  })

  test('every council or deps source id must be used by a clause or rejected', () => {
    const p = plan([clause('S1.1', 'behavior', { source: 'council#1' })])
    expect(checkPlan(p, { signals: [], sources: ['council#1', 'council#2'] })).toEqual(['council#2 is neither a clause source nor rejected'])
    p.rejected = [{ id: 'council#2', reason: 'out of scope' }]
    expect(checkPlan(p, { signals: [], sources: ['council#1', 'council#2'] })).toEqual([])
  })
})

describe('triage rules', () => {
  test('size thresholds', () => {
    expect(sizeOf(['a', 'b'])).toBe('S')
    expect(sizeOf(['a', 'a', 'b'])).toBe('S')
    expect(sizeOf(['a', 'b', 'c'])).toBe('M')
    expect(sizeOf(Array.from({ length: 8 }, (_, i) => `f${i}`))).toBe('M')
    expect(sizeOf(Array.from({ length: 9 }, (_, i) => `f${i}`))).toBe('L')
  })

  test('risk drops only dismissed signals', () => {
    const signals = [{ id: 'auth', where: 'task' }, { id: 'money', where: 'x.ts:1' }]
    expect(riskOf(signals, [])).toEqual({ risk: 'high', signals })
    expect(riskOf(signals, ['auth', 'money'])).toEqual({ risk: 'low', signals: [] })
    expect(riskOf(signals, ['auth']).signals).toEqual([{ id: 'money', where: 'x.ts:1' }])
  })

  test('parseDismiss requires a reason', () => {
    expect(parseDismiss(['auth: internal tool only'])).toEqual([{ id: 'auth', reason: 'internal tool only' }])
    expect(() => parseDismiss(['auth'])).toThrow('reason')
  })

  test('tiers only rise', () => {
    expect(raiseTier('S', 'M')).toBe('M')
    expect(raiseTier('L', 'S')).toBe('L')
  })

  test('dosing follows the SPEC §6 table', () => {
    expect(dosing('S', 'low')).toMatchObject({ council: false, shadow: false, checkpointAfterPlan: false, attackers: ['sonnet'] })
    expect(dosing('S', 'high')).toMatchObject({ council: false, shadow: true, checkpointAfterPlan: true, checkpointAfterSlice: false, attackers: ['opus', 'opus'] })
    expect(dosing('M', 'low')).toMatchObject({ council: false, checkpointAfterPlan: true, attackers: ['opus'] })
    expect(dosing('L', 'high')).toMatchObject({ council: true, checkpointAfterSlice: true, attackers: ['opus', 'opus'] })
  })
})

describe('git and shell helpers', () => {
  test('parsePorcelain reads modified, untracked, renamed and quoted paths', () => {
    expect(parsePorcelain(' M src/a.ts\n?? src/new.ts\nR  old.ts -> new name.ts\nA  "sp ace.ts"\n'))
      .toEqual(['src/a.ts', 'src/new.ts', 'new name.ts', 'sp ace.ts'])
    expect(parsePorcelain('')).toEqual([])
  })

  test('isProtected covers harness files at any depth and spares sources', () => {
    for (const p of ['package.json', 'pkg/package.json', 'bunfig.toml', 'tsconfig.base.json', 'bun.lock', 'yarn.lock',
      'package-lock.json', 'pnpm-lock.yaml', 'vitest.config.ts', 'jest.config.js', '.github/workflows/ci.yml',
      'pyproject.toml', 'Cargo.lock', 'conftest.py']) expect(isProtected(p)).toBe(true)
    for (const p of ['src/package.ts', 'src/text.test.ts', 'docs/tsconfig.md']) expect(isProtected(p)).toBe(false)
  })

  test('q quotes for bash, including single quotes', () => {
    expect(q("it's a b")).toBe(`'it'\\''s a b'`)
  })

  test('ledgerLine uses a 7-char sha', () => {
    expect(ledgerLine('verified', 'bun test → 0', 'a1b2c3d4e5f6')).toBe('[verified] bun test → 0 @a1b2c3d')
    expect(ledgerLine('decision', 'x')).toBe('[decision] x')
  })

  test('paths keep worktrees outside the repo', () => {
    expect(paths('/r/app/', 'id1')).toEqual({
      dir: '/r/app', runDir: '/r/app/.claude/runs/id1', wtRoot: '/r/app.forge/id1',
      main: '/r/app.forge/id1/main', branch: 'forge/id1/main',
    })
  })

  test('junitCommand supports bun test and refuses what it cannot parse', () => {
    expect(junitCommand('bun test', '/o/x.xml')).toBe(`bun test --reporter=junit --reporter-outfile='/o/x.xml'`)
    expect(junitCommand('npm test', '/o/x.xml')).toBeNull()
  })
})
