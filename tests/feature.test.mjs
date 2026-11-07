// Runs feature.js against stubbed agents and checks the prompts it builds and
// the decisions the script takes from their results.
// Run: just test (or node --test tests/feature.test.mjs)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../.agents/claude/workflows/feature.js', import.meta.url), 'utf8')
  .replace(/^export const meta/m, 'const meta')
const AsyncFunction = (async () => {}).constructor
const script = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', SRC)

const question = id => ({
  id, question: `Which ${id}?`,
  options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
  recommendation: { option: 'A', why: 'w', wouldChangeIf: 'c' },
})

const FIXTURES = {
  'sh': { output: 'EXIT=0' },
  'explore:conventions': { digest: 'conventions digest' },
  'explore:code': { digest: 'code digest' },
  'explore:gate': { digest: 'gate digest', gateCommand: 'npm test', lintCommand: 'npm run lint' },
  'intent': {
    status: 'ok', reason: '', evidence: [], digest: 'intent digest',
    acceptance: [{ criterion: 'c', check: 'npm test' }], questions: [question('scope')],
  },
}

// The longest fixture key that prefixes the label wins, so 'sh:baseline' beats 'sh'.
const fixtureFor = (label, fixtures) => {
  const key = Object.keys(fixtures)
    .filter(k => label === k || label.startsWith(k + ':'))
    .sort((a, b) => b.length - a.length)[0]
  if (key === undefined) throw new Error(`no fixture for label ${label}`)
  const f = fixtures[key]
  return structuredClone(typeof f === 'function' ? f(label) : f)
}

// calls is a parameter so a test can still read it when the run throws.
async function run(args, overrides = {}, calls = []) {
  const fixtures = { ...FIXTURES, ...overrides }
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

const BASE = { dir: '/repo', slug: 'add-thing', today: '2026-11-07' }
const INTENT = { ...BASE, stage: 'intent', task: 'add a thing' }

// --- arguments -------------------------------------------------------------

test('a missing args.today is an error', async () => {
  const { today, ...noDate } = INTENT
  await assert.rejects(run(noDate), /today/)
})

test('an unknown stage, a relative dir, or a bad slug is an error', async () => {
  await assert.rejects(run({ ...INTENT, stage: 'ship' }), /stage/)
  await assert.rejects(run({ ...INTENT, dir: 'repo' }), /dir/)
  await assert.rejects(run({ ...INTENT, slug: '../x' }), /slug/)
})

// --- shell lines -----------------------------------------------------------

const shellPrompts = calls => calls.filter(c => c.opts.label.startsWith('sh:')).map(c => c.prompt)

test('every heredoc in a shell prompt has its terminator at column 0', async () => {
  const { calls } = await run(INTENT)
  for (const p of calls.map(c => c.prompt)) {
    const lines = p.split('\n')
    lines.forEach((l, i) => {
      for (const [, tag] of l.matchAll(/<<'(\w+)'/g)) {
        assert.ok(lines.slice(i + 1).includes(tag), `heredoc ${tag} never closes`)
      }
    })
  }
})

test('shell lines quote a dir that contains a space or a single quote', async () => {
  const { calls } = await run({ ...INTENT, dir: "/it's my repo" })
  const prompts = shellPrompts(calls)
  assert.ok(prompts.length)
  for (const p of prompts) {
    if (p.includes('cd ')) assert.ok(p.includes(`cd '/it'\\''s my repo'`), p)
  }
})

test('no prompt pipes into tail without pipefail', async () => {
  const { calls } = await run(INTENT)
  for (const { prompt, opts } of calls) {
    if (/\|\s*tail/.test(prompt)) assert.match(prompt, /set -o pipefail/, opts.label)
  }
})

test('the run dir is excluded from git through info/exclude', async () => {
  const { byLabel } = await run(INTENT)
  const setup = byLabel('sh:setup')[0].prompt
  assert.match(setup, /rev-parse --git-path info\/exclude/)
  assert.match(setup, /\/\.claude\/runs\//)
})

// --- exit codes ------------------------------------------------------------

test('the baseline runs twice, and the script reads EXIT itself', async () => {
  const { byLabel, result } = await run(INTENT, {
    'sh:baseline:1': { output: 'ok\nEXIT=0' },
    'sh:baseline:2': { output: 'ok\nEXIT=0' },
  })
  assert.equal(byLabel('sh:baseline:1').length, 1)
  assert.equal(byLabel('sh:baseline:2').length, 1)
  assert.match(byLabel('sh:baseline:1')[0].prompt, /alarm shift; exec @ARGV/)
  // A gate written as `x | tail` must fail when x fails, so pipefail goes inside the child.
  assert.ok(byLabel('sh:baseline:1')[0].prompt.includes(`bash -c 'set -o pipefail; npm test'`))
  assert.deepEqual(result.baseline.runs, ['pass', 'pass'])
  assert.equal(result.baseline.flaky, false)
})

test('EXIT=142 is TIMEOUT, a missing EXIT line is a failure, a split is flaky', async () => {
  const { result } = await run(INTENT, {
    'sh:baseline:1': { output: 'EXIT=142' },
    'sh:baseline:2': { output: 'all good, trust me' },
  })
  assert.deepEqual(result.baseline.runs, ['TIMEOUT', 'missing'])
  assert.equal(result.baseline.flaky, true)
})

test('a failing setup stops the run before any reader', async () => {
  const calls = []
  await assert.rejects(run(INTENT, { 'sh:setup': { output: 'mkdir: denied\nEXIT=1' } }, calls), /setup/)
  assert.equal(calls.filter(c => c.opts.label.startsWith('explore:')).length, 0)
})

// --- intent ----------------------------------------------------------------

test('three readers run on sonnet at high effort, and intent on opus', async () => {
  const { calls, byLabel } = await run(INTENT)
  const readers = calls.filter(c => c.opts.label.startsWith('explore:'))
  assert.equal(readers.length, 3)
  for (const r of readers) {
    assert.equal(r.opts.model, 'sonnet')
    assert.equal(r.opts.effort, 'high')
    assert.match(r.prompt, /path:line/)
  }
  assert.equal(byLabel('intent')[0].opts.model, 'opus')
})

test('intent gets the task verbatim, the date, and the explore files', async () => {
  const { byLabel } = await run({ ...INTENT, task: 'make `x` faster' })
  const p = byLabel('intent')[0].prompt
  assert.ok(p.includes('make `x` faster'))
  assert.ok(p.includes('2026-11-07'))
  for (const f of ['conventions', 'code', 'gate']) assert.ok(p.includes(`/repo/.claude/runs/add-thing/explore/${f}.md`), f)
})

test('a needs-human from intent stops the run and returns its evidence', async () => {
  const { result } = await run(INTENT, {
    intent: { status: 'needs-human', reason: 'the task contradicts itself', evidence: ['src/a.js:3'], digest: 'd', acceptance: [], questions: [question('x')] },
  })
  assert.equal(result.status, 'needs-human')
  assert.deepEqual(result.evidence, ['src/a.js:3'])
  assert.deepEqual(result.questions, [])
  assert.equal(result.next, null)
})

test('intent questions come back with neutral options and a separate recommendation', async () => {
  const { result } = await run(INTENT)
  assert.equal(result.status, 'questions')
  assert.equal(result.questions.length, 1)
  assert.equal(result.questions[0].recommendation.option, 'A')
  assert.match(result.next, /design/)
})

test('every agent label is unique within a run', async () => {
  const { calls } = await run(INTENT)
  const labels = calls.map(c => c.opts.label)
  assert.deepEqual(labels.filter((l, i) => labels.indexOf(l) !== i), [])
})
