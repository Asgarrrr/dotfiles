// Runs big-feature.js against stubbed agents and checks the prompts it builds.
// Run: just test (or node --test tests/big-feature.test.mjs)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../.agents/claude/workflows/big-feature.js', import.meta.url), 'utf8')
  .replace(/^export const meta/m, 'const meta')
const AsyncFunction = (async () => {}).constructor
const script = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', SRC)

const SLICES = [
  { title: 'Skeleton', files: ['a.js'], structure: 'none', structureJustification: 'none', approach: 'a',
    contract: 'c1', risk: 'low', verification: 'node --test a.test.js' },
  { title: 'Persist', files: ['b.js'], structure: 'none', structureJustification: 'none', approach: 'b',
    contract: 'c2', risk: 'high', verification: 'node --test b.test.js' },
]
const vet = claim => ({ sourcesConsulted: ['https://example.com'], findings: [{ claim, evidence: 'https://example.com', impact: 'shapes-plan' }] })
const FIXTURES = {
  'explore': { notes: 'notes' },
  'vet:deps': { sourcesConsulted: ['https://registry'], findings: [{ claim: 'DEPS-BLOCKER', evidence: 'https://registry', impact: 'blocks-plan' }] },
  'council:opus': vet('OPUS-CONCERN'),
  'council:fable': vet('FABLE-CONCERN'),
  'council:gpt': vet('GPT-CONCERN'),
  'council:synth': { concerns: [{ claim: 'OPUS-CONCERN', evidence: 'e', impact: 'shapes-plan', raisedBy: ['council:opus'], missedBy: ['council:gpt'] }] },
  'rebut': { verdict: 'real', reasoning: 'r' },
  'preflight': { treeClean: true, dirtyFiles: [], testCommand: 'npm test', testExitCode: 0, failingTests: [],
    branch: 'feat', head: 'ba5e123' },
  'plan': { slices: SLICES },
  'plan:audit': { gaps: [] },
  'slice': { title: 't', status: 'done', command: 'x', exitCode: 0, output: 'ok', commit: 'c0ffee' },
  'peer': { verdict: 'pass', issues: [] },
  'review': { findings: [{ file: 'a.js', issue: 'bug', severity: 'must-fix' }] },
  'red': { findings: [] },
  'fix': null,
  'recheck': { outcomes: [{ file: 'a.js', state: 'fixed' }], testExitCode: 0 },
}

// The longest fixture key that prefixes the label wins, so 'plan:audit' beats 'plan'.
const fixtureFor = (label, fixtures) => {
  const key = Object.keys(fixtures)
    .filter(k => label === k || label.startsWith(k + ':'))
    .sort((a, b) => b.length - a.length)[0]
  if (key === undefined) throw new Error(`no fixture for label ${label}`)
  return structuredClone(fixtures[key])
}

async function run(args, overrides = {}) {
  const fixtures = { ...FIXTURES, ...overrides }
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return fixtureFor(opts.label, fixtures)
  }
  const parallel = ts => Promise.all(ts.map(t => t().catch(() => null)))
  const result = await script(args, agent, parallel, () => {}, m => logs.push(m))
  const byLabel = l => calls.filter(c => c.opts.label === l)
  return { calls, logs, result, byLabel }
}

const FULL = { task: 'add a thing', dir: '/repo', go: true, gpt: true, fable: true }

test('every agent label is unique within a run', async () => {
  const long = 'Persist the session store to disk across restarts'
  const slices = [0, 1].map(i => ({ ...SLICES[1], title: `${long} part ${i}` }))
  const concern = claim => ({ claim, evidence: 'e', impact: 'shapes-plan', raisedBy: ['council:opus'], missedBy: ['council:gpt'] })
  const synth = { concerns: [concern('The migration will break readers'), concern('The migration will drop rows')] }
  const { calls } = await run(FULL, { plan: { slices }, 'council:synth': synth })
  const labels = calls.map(c => c.opts.label)
  const dupes = labels.filter((l, i) => labels.indexOf(l) !== i)
  assert.deepEqual(dupes, [])
})

test('no codex shell line carries the placeholder dir', async () => {
  const { calls } = await run({ task: 't', gpt: true })
  const lines = calls.flatMap(c => c.prompt.split('\n')).filter(l => l.includes('codex exec'))
  assert.ok(lines.length, 'expected a codex exec line')
  for (const l of lines) assert.doesNotMatch(l, /current working directory/)
})

test('codex -C quotes a dir that contains a space or a single quote', async () => {
  const { calls } = await run({ task: 't', dir: "/it's my repo", gpt: true })
  const lines = calls.flatMap(c => c.prompt.split('\n')).filter(l => l.includes('codex exec'))
  assert.ok(lines.length)
  for (const l of lines) assert.ok(l.includes(`-C '/it'\\''s my repo' `), l)
})

test('every heredoc in a codex call has its terminator at column 0', async () => {
  const { calls } = await run({ task: 't', dir: '/repo', gpt: true })
  const prompts = calls.map(c => c.prompt).filter(p => p.includes('codex exec'))
  assert.ok(prompts.length)
  for (const p of prompts) {
    const lines = p.split('\n')
    lines.forEach((l, i) => {
      for (const [, tag] of l.matchAll(/<<'(\w+)'/g)) {
        assert.ok(lines.slice(i + 1).includes(tag), `heredoc ${tag} never closes`)
      }
    })
  }
})

test('a vet:deps blocks-plan finding reaches the planner and the audit when the council synthesises', async () => {
  const { byLabel } = await run({ task: 't', dir: '/repo', gpt: true })
  assert.equal(byLabel('council:synth').length, 1, 'precondition: synthesis ran')
  assert.match(byLabel('plan')[0].prompt, /DEPS-BLOCKER/)
  assert.match(byLabel('plan:audit')[0].prompt, /DEPS-BLOCKER/)
  const plan = byLabel('plan')[0].prompt
  assert.ok(plan.indexOf('DEPS-BLOCKER') < plan.indexOf('OPUS-CONCERN'), 'blocks-plan before shapes-plan')
})

test('a carried plan runs preflight', async () => {
  const { byLabel } = await run({ task: 't', dir: '/repo', go: true, slices: SLICES })
  assert.equal(byLabel('preflight').length, 1)
})

test('each role runs on the model in the table', async () => {
  // Table mirrors CLAUDE.md roles as the script applies them today.
  const TABLE = {
    explore: 'sonnet', 'vet:deps': 'opus', 'council:opus': 'opus', 'council:fable': 'fable',
    'council:gpt': 'sonnet', 'council:synth': 'opus', rebut: null, preflight: 'sonnet',
    plan: 'fable', 'plan:audit': 'opus', peer: 'sonnet', review: 'opus', red: 'opus',
    fix: 'sonnet', recheck: 'sonnet',
  }
  const { calls } = await run(FULL)
  for (const { opts } of calls) {
    const role = Object.keys(TABLE).filter(k => opts.label === k || opts.label.startsWith(k + ':'))
      .sort((a, b) => b.length - a.length)[0]
    if (role === 'rebut' || opts.label.startsWith('slice:')) continue
    assert.ok(role, `label ${opts.label} has no role in the table`)
    assert.equal(opts.model, TABLE[role], `${opts.label}`)
  }
  const slice = calls.filter(c => c.opts.label.startsWith('slice:')).map(c => c.opts.model)
  assert.deepEqual(slice, ['sonnet', 'opus'], 'low risk with contract on sonnet, high risk on opus')
  const { calls: noFable } = await run({ ...FULL, fable: false })
  assert.equal(noFable.find(c => c.opts.label === 'plan').opts.model, 'opus')
})

test('each slice commits with trailers that name the run base and the slice', async () => {
  const { calls } = await run(FULL)
  const briefs = calls.filter(c => /^slice:\d+:[^:]*$/.test(c.opts.label)).map(c => c.prompt)
  assert.equal(briefs.length, 2)
  briefs.forEach((b, i) => {
    assert.match(b, /Big-Feature-Base: ba5e123/)
    assert.match(b, new RegExp(`Big-Feature-Slice: ${i + 1}/2`))
    assert.match(b, /never `git add -A`/)
  })
})

test('a slice that reports done without a commit blocks the run', async () => {
  const { result, byLabel } = await run(FULL, { slice: { title: 't', status: 'done', command: 'x', exitCode: 0, output: 'ok' } })
  assert.equal(result.mode, 'blocked')
  assert.equal(byLabel('peer:1:Skeleton:1').length, 0, 'no review of an uncommitted slice')
})

test('the peer review reads the slice commits, not the whole tree', async () => {
  const { calls } = await run(FULL)
  const peer = calls.find(c => c.opts.label.startsWith('peer:1:'))
  assert.match(peer.prompt, /git log -p ba5e123\.\.c0ffee --grep="Big-Feature-Slice: 1\/2"/)
  assert.doesNotMatch(peer.prompt, /uncommitted changes/)
})

test('the final review reads every commit since the run base', async () => {
  const { byLabel } = await run(FULL)
  assert.match(byLabel('review')[0].prompt, /git diff ba5e123\.\.HEAD/)
})

test('a run on a protected branch stops before the first slice', async () => {
  for (const branch of ['main', 'master', 'develop']) {
    const { result, calls } = await run(FULL, { preflight: { ...FIXTURES.preflight, branch } })
    assert.equal(result.mode, 'blocked', branch)
    assert.equal(calls.filter(c => c.opts.label.startsWith('slice:')).length, 0, branch)
  }
})

test('each peer review starts at the previous slice commit, the retry included', async () => {
  const slice = commit => ({ ...FIXTURES.slice, commit })
  const { byLabel } = await run(FULL, {
    'slice:1': slice('s1'), 'slice:2': slice('s2a'), 'slice:2:Persist:retry': slice('s2b'),
    'peer:2:Persist:1': { verdict: 'fail', issues: ['x'] },
  })
  assert.match(byLabel('peer:2:Persist:1')[0].prompt, /s1\.\.s2a /)
  assert.match(byLabel('peer:2:Persist:2')[0].prompt, /s1\.\.s2b /)
})

test('a retry that reports done without a commit blocks the run', async () => {
  const { result, byLabel } = await run(FULL, {
    'peer:1:Skeleton:1': { verdict: 'fail', issues: ['x'] },
    'slice:1:Skeleton:retry': { ...FIXTURES.slice, commit: '' },
  })
  assert.equal(result.mode, 'blocked')
  assert.equal(byLabel('peer:1:Skeleton:2').length, 0)
})

test('a run without a known base commit stops before the first slice and keeps the plan', async () => {
  for (const preflight of [null, { ...FIXTURES.preflight, head: '' }, { ...FIXTURES.preflight, head: 'HEAD' }]) {
    const { result, calls } = await run(FULL, { preflight })
    assert.equal(result.mode, 'blocked')
    assert.equal(calls.filter(c => c.opts.label.startsWith('slice:')).length, 0)
    assert.deepEqual(result.slices, SLICES)
    assert.doesNotMatch(result.next, /resumeFromRunId replays/)
  }
})

test('the red team reads the run commits and the fix commits with the review trailer', async () => {
  const { byLabel } = await run(FULL)
  assert.match(byLabel('red')[0].prompt, /git diff ba5e123\.\.HEAD/)
  assert.match(byLabel('fix')[0].prompt, /Big-Feature-Base: ba5e123" and "Big-Feature-Slice: review"/)
})

test('a slice is told which files held uncommitted work before the run', async () => {
  const { byLabel } = await run(FULL, { preflight: { ...FIXTURES.preflight, treeClean: false, dirtyFiles: ['a.js'] } })
  assert.match(byLabel('slice:1:Skeleton')[0].prompt, /uncommitted work before the run: a\.js/)
})
