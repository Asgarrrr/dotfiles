import { expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runForge } from '../harness/run.js'
import { makeRepo } from '../harness/repo.js'
import { lyingScribe, sha256 } from '../harness/fakes.js'

const T = 120_000
const ofRole = (calls, role) => calls.filter(c => c.role === role)
const MAIN = 'forge/sim/main'

// Scripted builder whose B stage ships the planted bug (trim() instead of stripping
// edge hyphens) — every builder test still passes, only red can find it.
const plantedBug = {
  builder: (ctx, h) => {
    h.copyInto(ctx.stage === 'B' ? 'B-buggy' : 'A', ctx.worktree)
    return ctx.stage === 'A' ? h.json('builder-A.json') : { done: true }
  },
  red: (ctx, h) => {
    h.copyInto('red-planted', ctx.worktree)
    return h.json('red-planted.json')
  },
}
const blueWith = variant => (ctx, h) => {
  h.copyInto(variant, ctx.worktree)
  return h.json('blue-fix.json')
}
const approveAll = first => ({
  resume: '.claude/runs/sim',
  approve: {
    hash: first.result.planHash,
    answers: Object.fromEntries(first.result.questions.map(q => [q.id, 'yes'])),
  },
})

test('1 · each slice has commits A and B; clause tests fail correctly at A and pass at B', async () => {
  const r = await runForge({ sim: 'slugify' })
  expect(r.result.status).toBe('done')
  const s1 = r.json('slices/S1.json')
  expect(r.git(`log -1 --format=%s ${s1.commits.A}`)).toBe('S1 tests')
  expect(r.git(`log -1 --format=%s ${s1.commits.B}`)).toBe('S1 impl')
  expect(r.git(`rev-parse ${s1.commits.B}~1`)).toBe(s1.commits.A)
  expect(r.git(`rev-list ${MAIN}`)).toContain(s1.commits.B)
  const clauseTests = s1.atA.filter(t => t.clause)
  expect(clauseTests.map(t => t.clause).sort()).toEqual(['S1.1', 'S1.2', 'S1.3'])
  expect(clauseTests.every(t => t.outcome === 'fail')).toBe(true)
  expect(s1.atB.every(t => t.outcome === 'pass')).toBe(true)
  expect(r.ledger()).toContain(`@${s1.commits.B.slice(0, 7)}`)
  expect(r.git('status --porcelain')).toBe('')
}, T)

test('2 · a too_weak builder test goes back to the builder once; the judge never sees code', async () => {
  let judged = 0
  const r = await runForge({ sim: 'slugify', overrides: {
    judge: ctx => {
      judged++
      return { verdicts: ctx.items.map(i => ({
        ref: i.ref,
        verdict: judged === 1 && i.clause.id === 'S1.1' ? 'too_weak' : 'valid',
      })) }
    },
  } })
  const builderA = ofRole(r.calls, 'builder').filter(c => c.ctx.stage === 'A')
  expect(builderA).toHaveLength(2)
  expect(builderA[1].ctx.retry).toEqual([expect.objectContaining({ clause: 'S1.1', verdict: 'too_weak' })])
  const firstJudge = ofRole(r.calls, 'judge')[0]
  expect(firstJudge.ctx.items.find(i => i.clause.id === 'S1.1').source).toContain("slugify('Hello World')")
  expect(JSON.stringify(firstJudge.ctx)).not.toContain('not implemented')
  expect(r.json('slices/S1.json').judge).toContainEqual(expect.objectContaining({ clause: 'S1.1', verdict: 'too_weak', attempt: 1 }))
}, T)

test('3 · a red test with a wrong oracle is rejected by the judge and never lands', async () => {
  const r = await runForge({ sim: 'slugify', overrides: {
    red: (ctx, h) => { h.copyInto('red-restating', ctx.worktree); return h.json('red-restating.json') },
    judge: ctx => ({ verdicts: ctx.items.map(i => ({ ref: i.ref, verdict: i.test.startsWith('b1') ? 'wrong_oracle' : 'valid' })) }),
  } })
  const bug = r.json('slices/S1.json').duel.rounds[0].bugs[0]
  expect(bug).toMatchObject({ id: 'b1', verdict: 'wrong_oracle', status: 'discarded' })
  expect(r.git(`ls-tree -r --name-only ${MAIN}`)).not.toContain('src/red/')
  expect(ofRole(r.calls, 'blue')).toHaveLength(0)
}, T)

test('4 · a blue fix that edits a red test file is flagged by anti-tamper', async () => {
  const r = await runForge({ sim: 'slugify', overrides: { ...plantedBug, blue: blueWith('blue-tamper') } })
  const s1 = r.json('slices/S1.json')
  expect(s1.duel.rounds[0].bugs[0].status).toBe('tamper')
  expect(s1.status).toBe('blocked')
  expect(r.ledger()).toMatch(/\[failed\] S1 .*tamper/)
}, T)

test('5 · a blue fix that special-cases variant 1 fails the held-out variant 2', async () => {
  const r = await runForge({ sim: 'slugify', overrides: { ...plantedBug, blue: blueWith('blue-specialcase') } })
  const s1 = r.json('slices/S1.json')
  expect(s1.duel.rounds[0].bugs[0].status).toBe('held-out-failed')
  expect(s1.status).toBe('escalated')
  const blueCtx = JSON.stringify(ofRole(r.calls, 'blue')[0].ctx)
  expect(blueCtx).not.toContain('-v2')
}, T)

test('6 · a builder change to a harness file blocks the slice as protected', async () => {
  const r = await runForge({ sim: 'slugify', overrides: {
    builder: (ctx, h) => {
      h.copyInto(ctx.stage, ctx.worktree)
      writeFileSync(join(ctx.worktree, 'package.json'), '{ "name": "forge-fixture", "type": "module", "scripts": { "test": "bun test || true" } }\n')
      return ctx.stage === 'A' ? h.json('builder-A.json') : { done: true }
    },
  } })
  const s1 = r.json('slices/S1.json')
  expect(s1.status).toBe('blocked')
  expect(s1.protectedTouched).toContain('package.json')
  expect(s1.commits.B).toBeUndefined()
  expect(ofRole(r.calls, 'red')).toHaveLength(0)
}, T)

test('7 · a planted bug is caught by red, judged valid, and fixed; both variants stay', async () => {
  let redHead = null
  const r = await runForge({ sim: 'slugify', overrides: {
    ...plantedBug,
    red: (ctx, h) => {
      redHead = execSync('git rev-parse HEAD', { cwd: ctx.worktree, encoding: 'utf8' }).trim()
      return plantedBug.red(ctx, h)
    },
    blue: blueWith('blue-fix'),
  } })
  const s1 = r.json('slices/S1.json')
  expect(redHead).toBe(s1.commits.A)
  expect(s1.duel.rounds[0].bugs[0]).toMatchObject({ id: 'b1', verdict: 'valid', status: 'fixed' })
  expect(s1.commits.R).toBeDefined()
  expect(s1.commits.F).toBeDefined()
  const tree = r.git(`ls-tree -r --name-only ${MAIN}`)
  expect(tree).toContain('src/red/S1-b1-v1.test.ts')
  expect(tree).toContain('src/red/S1-b1-v2.test.ts')
  expect(r.git(`diff ${s1.commits.R} ${s1.commits.F} -- src/red/`)).toBe('')
  expect(r.result.status).toBe('done')
}, T)

test('8 · an auth task whose plan lacks a negative clause fails the plan check', async () => {
  const r = await runForge({ sim: 'export', overrides: {
    planner: (ctx, h) => {
      const plan = h.json('plan.json')
      plan.slices[0].spec = plan.slices[0].spec.filter(c => c.kind !== 'negative')
      return plan
    },
  } })
  expect(ofRole(r.calls, 'planner')).toHaveLength(2)
  expect(r.result.status).toBe('escalated')
  expect(r.result.reason).toContain('negative')
  expect(ofRole(r.calls, 'builder')).toHaveLength(0)
}, T)

test('9 · resume after a manual commit marks older facts stale and re-verifies first', async () => {
  const first = await runForge({ sim: 'export' })
  expect(first.result.status).toBe('checkpoint')
  const run = first.json('run.json')
  execSync('git commit -q --allow-empty -m manual', { cwd: run.worktree })
  const second = await runForge({ sim: 'export', repo: first.repo, args: approveAll(first) })
  expect(second.ledger()).toMatch(/\[stale\] facts before [0-9a-f]{7}/)
  const labels = second.calls.map(c => c.label)
  const reverify = labels.findIndex(l => l.startsWith('runner:reverify'))
  const build = labels.findIndex(l => l.startsWith('builder:'))
  expect(reverify).toBeGreaterThan(-1)
  expect(build).toBeGreaterThan(reverify)
}, T)

test('10 · a scribe that returns without writing fails the hash check', async () => {
  const r = await runForge({ sim: 'slugify', overrides: { scribe: lyingScribe } })
  expect(r.result.status).toBe('error')
  expect(r.result.reason).toMatch(/hash/)
  expect(ofRole(r.calls, 'builder')).toHaveLength(0)
}, T)

test('11 · an approval whose hash differs from the shown plan is refused', async () => {
  const first = await runForge({ sim: 'export' })
  const args = approveAll(first)
  args.approve.hash = 'f'.repeat(64)
  const second = await runForge({ sim: 'export', repo: first.repo, args })
  expect(second.result).toMatchObject({ status: 'refused', reason: 'hash-mismatch' })
  expect(ofRole(second.calls, 'builder')).toHaveLength(0)
}, T)

test('12 · a low-risk S task never reaches council, shadow, or a checkpoint', async () => {
  const r = await runForge({ sim: 'slugify' })
  expect(r.result.status).toBe('done')
  for (const role of ['seat', 'shadow', 'comparator']) expect(ofRole(r.calls, role)).toHaveLength(0)
  const reds = ofRole(r.calls, 'red')
  expect(reds).toHaveLength(1)
  expect(reds[0].opts.model).toBe('sonnet')
}, T)

test('13 · a planted ambiguity surfaces as a question; no checkpoint shows more than 5', async () => {
  const one = await runForge({ sim: 'export' })
  expect(one.result.status).toBe('checkpoint')
  expect(one.result.questions.some(q => q.text.includes('403') && q.text.includes('404'))).toBe(true)

  const N = 7
  const many = await runForge({ sim: 'export', overrides: {
    planner: (ctx, h) => {
      const plan = h.json('plan.json')
      plan.slices[0].spec = [plan.slices[0].spec[0], ...Array.from({ length: N }, (_, i) => ({
        id: `S1.${i + 2}`, kind: 'negative', input: `member case ${i}`, action: 'exportReport(user)',
        expected: `status 40${i}`, source: 'task',
      }))]
      return plan
    },
    shadow: () => ({ clauses: Array.from({ length: N }, (_, i) => ({
      id: `H${i + 1}`, kind: 'negative', input: `member case ${i}`, action: 'exportReport(user)',
      expected: `status 41${i}`, signal: 'auth',
    })) }),
    comparator: () => ({ pairs: Array.from({ length: N }, (_, i) => ({
      planner_clause: `S1.${i + 2}`, shadow_clause: `H${i + 1}`, verdict: 'differs',
    })) }),
  } })
  expect(many.result.status).toBe('checkpoint')
  expect(many.result.questions).toHaveLength(5)
  expect(many.result.underspecified).toBe(true)
}, T)

// ---- regressions beyond SPEC §14, from the M1 review ----

const weaken = (worktree, file, from, to) => {
  const path = join(worktree, file)
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to))
}

test('14 · a builder that weakens a clause test at B is flagged as tamper', async () => {
  const r = await runForge({ sim: 'slugify', overrides: {
    builder: (ctx, h) => {
      h.copyInto(ctx.stage === 'B' ? 'B-buggy' : 'A', ctx.worktree)
      if (ctx.stage === 'B') weaken(ctx.worktree, 'src/text.test.ts', "toBe('hello')", 'toBeTruthy()')
      return ctx.stage === 'A' ? h.json('builder-A.json') : { done: true }
    },
  } })
  expect(r.json('slices/S1.json').status).toBe('blocked')
  expect(r.ledger()).toMatch(/\[failed\] S1 .*tamper.*src\/text\.test\.ts/)
}, T)

test('15 · a blue fix that weakens a builder clause test is flagged as tamper', async () => {
  const r = await runForge({ sim: 'slugify', overrides: { ...plantedBug, blue: (ctx, h) => {
    weaken(ctx.worktree, 'src/text.test.ts', "toBe('hello')", 'toBeTruthy()')
    return blueWith('blue-fix')(ctx, h)
  } } })
  expect(r.json('slices/S1.json').status).toBe('blocked')
  expect(r.ledger()).toMatch(/\[failed\] S1 .*tamper.*src\/text\.test\.ts/)
}, T)

test('16 · an agent that commits on its own is blocked, even with a clean tree', async () => {
  const r = await runForge({ sim: 'slugify', overrides: {
    builder: (ctx, h) => {
      h.copyInto(ctx.stage, ctx.worktree)
      writeFileSync(join(ctx.worktree, 'package.json'), '{ "name": "forge-fixture", "type": "module" }\n')
      execSync('git add -A && git commit -q -m sneaky', { cwd: ctx.worktree })
      return ctx.stage === 'A' ? h.json('builder-A.json') : { done: true }
    },
  } })
  expect(r.json('slices/S1.json').status).toBe('blocked')
  expect(r.result.reason).toMatch(/committed/)
}, T)

test('17 · an attacker that returns nothing escalates instead of reporting no bug', async () => {
  const r = await runForge({ sim: 'slugify', overrides: { red: () => null } })
  expect(r.result.status).toBe('escalated')
  expect(r.result.reason).toMatch(/attacker/)
  expect(r.ledger()).not.toMatch(/no bug/)
}, T)

test('18 · allowRed runs on a red baseline and judges only new failures', async () => {
  const redRepo = () => {
    const repo = makeRepo('app')
    writeFileSync(join(repo, 'src/legacy.test.ts'), "import { expect, test } from 'bun:test'\ntest('legacy is broken', () => { expect(1).toBe(2) })\n")
    execSync('git add -A && git commit -q -m legacy', { cwd: repo })
    return repo
  }
  const blocked = await runForge({ sim: 'slugify', repo: redRepo() })
  expect(blocked.result).toMatchObject({ status: 'blocked' })
  expect(blocked.result.reason).toMatch(/red baseline/)
  const allowed = await runForge({ sim: 'slugify', repo: redRepo(), args: { allowRed: true } })
  expect(allowed.result.status).toBe('done')
}, T)

test('19 · a scribe that hashes the content without writing it fails the on-disk check', async () => {
  const hashingScribe = ({ writes = [] }) => ({ files: writes.map(({ path, content }) => ({ path, sha256: sha256(content), bytes: Buffer.byteLength(content) })) })
  const r = await runForge({ sim: 'slugify', overrides: { scribe: hashingScribe } })
  expect(r.result.status).toBe('error')
  expect(r.result.reason).toMatch(/on disk/)
  expect(ofRole(r.calls, 'builder')).toHaveLength(0)
}, T)
