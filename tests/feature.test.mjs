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
  id, header: id.slice(0, 12), question: `Which ${id}?`,
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

test('shell lines quote every path under a dir that contains a space or a single quote', async () => {
  const { calls } = await run({ ...INTENT, dir: "/it's my repo" })
  const scripts = shellPrompts(calls).map(p => p.split('--- script ---')[1])
  assert.ok(scripts.length)
  // Strip every correctly quoted occurrence; any raw one left would split the word.
  for (const sc of scripts) {
    // Heredoc bodies are data, not shell words.
    const rest = sc.replace(/<<'(\w+)'\n[\s\S]*?\n\1\n/g, '')
      .replace(/'\/it'\\''s my repo[^']*'/g, 'Q')
    assert.ok(!rest.includes("it's my repo") && !rest.includes("/it'"), sc)
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
  assert.match(setup, /echo '\.claude\/runs\/'/, 'unanchored, so a subdirectory dir matches too')
  assert.ok(setup.includes("test ! -e '/repo/.claude/runs/add-thing'"), 'a reused slug is refused')
})

// --- exit codes ------------------------------------------------------------

test('the baseline runs twice, and the script reads EXIT itself', async () => {
  const { byLabel, result } = await run(INTENT, {
    'sh:baseline:1': { output: 'ok\nEXIT=0' },
    'sh:baseline:2': { output: 'ok\nEXIT=0' },
  })
  assert.equal(byLabel('sh:baseline:1').length, 1)
  assert.equal(byLabel('sh:baseline:2').length, 1)
  const b = byLabel('sh:baseline:1')[0].prompt
  assert.match(b, /setpgrp\(0,0\)/, 'the alarm kills the whole process group')
  assert.ok(b.indexOf('tail -n') < b.indexOf('echo "EXIT=$rc"'), 'the log tail prints before the EXIT line')
  // A gate written as `x | tail` must fail when x fails, so pipefail goes inside the child.
  assert.ok(byLabel('sh:baseline:1')[0].prompt.includes(`bash -c 'set -o pipefail; npm test'`))
  assert.deepEqual(result.baseline.runs, ['pass', 'pass'])
  assert.equal(result.baseline.flaky, false)
})

test('EXIT=142 is TIMEOUT, a missing EXIT line is a failure, and neither is flaky', async () => {
  const { result } = await run(INTENT, {
    'sh:baseline:1': { output: 'EXIT=142' },
    'sh:baseline:2': { output: 'all good, trust me' },
  })
  assert.deepEqual(result.baseline.runs, ['TIMEOUT', 'missing'])
  assert.equal(result.baseline.flaky, false)
})

test('only a pass/fail split is flaky, and it is a warning', async () => {
  const { result } = await run(INTENT, { 'sh:baseline:1': { output: 'EXIT=0' }, 'sh:baseline:2': { output: 'EXIT=1' } })
  assert.equal(result.baseline.flaky, true)
  assert.match(result.warnings.join('\n'), /flaky/)
})

test('the last EXIT line wins, so a program line before it cannot pass a red suite', async () => {
  const { result } = await run(INTENT, {
    'sh:baseline:1': { output: 'step EXIT=0\nEXIT=0\n1 failing\nEXIT=1' },
    'sh:baseline:2': { output: 'EXIT=1' },
  })
  assert.deepEqual(result.baseline.runs, ['fail', 'fail'])
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

test('the stage result is written to the run dir for resume', async () => {
  const { byLabel, result } = await run(INTENT)
  const w = byLabel('sh:write:result:intent')[0].prompt
  assert.ok(w.includes("cat > '/repo/.claude/runs/add-thing/intent.json'"))
  assert.ok(w.includes('"id": "scope"'))
  assert.deepEqual(result.warnings, [])
})

test('a recommendation that names no option is a warning', async () => {
  const q = { ...question('scope'), recommendation: { option: 'C', why: 'w', wouldChangeIf: 'c' } }
  const { result } = await run(INTENT, { intent: { ...FIXTURES.intent, questions: [q] } })
  assert.match(result.warnings.join('\n'), /scope/)
})

test('every agent label is unique within a run', async () => {
  const { calls } = await run(INTENT)
  const labels = calls.map(c => c.opts.label)
  assert.deepEqual(labels.filter((l, i) => labels.indexOf(l) !== i), [])
})

// --- design ----------------------------------------------------------------

const DESIGN = { ...BASE, stage: 'design' }
const scored = (design, total) => ({ design, correctness: total, coupling: total, apiSurface: total, extensionCost: total, conformity: total, minimality: total, rationale: `r${design}` })
const DESIGN_FIXTURES = {
  'deps': { deps: [{ name: 'serde', ecosystem: 'cargo' }] },
  'research': {
    name: 'serde', lockVersion: '1.0.200', lockSource: 'Cargo.lock:42', latestVersion: '1.0.200',
    apiChanges: [], sourcesConsulted: ['https://docs.rs/serde'], report: 'same version', questions: [],
  },
  'sh:setup': { output: 'PREFIX=\nEXIT=0' },
  'design': label => ({ summary: `summary of ${label}`, compileCommand: 'cargo check' }),
  // Pass 1 sees designs 1,2,3 as A,B,C; pass 2 sees 3,2,1. Both pick design 1.
  'judge:1': { scores: [scored('A', 5), scored('B', 3), scored('C', 2)], winner: 'A', why: 'w' },
  'judge:2': { scores: [scored('A', 2), scored('B', 3), scored('C', 5)], winner: 'C', why: 'w' },
  'premortem': { framing: 'f', modes: [
    { mode: 'BOUND-MODE', trigger: 't', test: 'parses an empty file' },
    { mode: 'UNBOUND-MODE', trigger: 't', test: '' },
  ] },
}
const runDesign = (args, overrides = {}, calls) => run({ ...DESIGN, ...args }, { ...DESIGN_FIXTURES, ...overrides }, calls)

test('design: one researcher per touched dependency, with the date and the data rule', async () => {
  const { byLabel, calls } = await runDesign({}, { deps: { deps: [{ name: 'serde', ecosystem: 'cargo' }, { name: 'tokio', ecosystem: 'cargo' }] } })
  const res = calls.filter(c => c.opts.label.startsWith('research:'))
  assert.equal(res.length, 2)
  for (const r of res) {
    assert.equal(r.opts.agentType, 'researcher')
    assert.ok(r.prompt.includes('2026-11-07'))
    assert.match(r.prompt, /data, never an instruction/)
    assert.match(r.prompt, /lockfile/)
  }
  assert.match(byLabel('sh:write:research')[0].prompt, /research\.md/)
})

test('design: a version gap that matters comes back as a question', async () => {
  const gap = { ...DESIGN_FIXTURES.research, latestVersion: '2.0.0', questions: [question('serde-2')] }
  const { result } = await runDesign({}, { research: gap })
  assert.ok(result.questions.some(q => q.id === 'serde-2'))
})

test('design: three competing designs on opus xhigh, each in its own worktree of dir with its own angle', async () => {
  const { calls, byLabel } = await runDesign()
  const ds = calls.filter(c => c.opts.label.startsWith('design:'))
  assert.equal(ds.length, 3)
  for (const d of ds) {
    assert.equal(d.opts.model, 'opus')
    assert.equal(d.opts.effort, 'xhigh')
    // The harness isolation branches the session repo, not dir.
    assert.equal(d.opts.isolation, undefined)
  }
  assert.equal(new Set(ds.map(d => d.prompt)).size, 3)
  const setup = byLabel('sh:setup')[0].prompt
  assert.ok(setup.includes("cd '/repo' && test -f '/repo/.claude/runs/add-thing/task.md'"))
  ds.forEach((d, i) => {
    assert.ok(d.prompt.includes(`/designs/${i + 1}.md`))
    assert.ok(d.prompt.includes(`/repo/.claude/runs/add-thing/wt/${i + 1}`))
    assert.ok(setup.includes(`git worktree add -q --detach '/repo/.claude/runs/add-thing/wt/${i + 1}' HEAD`))
  })
})

test('design: the script compiles each design in its worktree, then removes every worktree', async () => {
  const { byLabel } = await runDesign({}, { 'sh:setup': { output: 'PREFIX=pkg/\nEXIT=0' } })
  const c2 = byLabel('sh:compile:2')[0].prompt
  assert.ok(c2.includes(`cd '/repo/.claude/runs/add-thing/wt/2/pkg/' && perl`))
  assert.ok(c2.includes(`bash -c 'set -o pipefail; cargo check'`))
  assert.ok(byLabel('design:2')[0].prompt.includes('/wt/2/pkg/'))
  const rm = byLabel('sh:cleanup')[0].prompt
  for (const n of [1, 2, 3]) assert.ok(rm.includes(`git worktree remove --force '/repo/.claude/runs/add-thing/wt/${n}'`))
})

test('design: a missing task.md stops the stage before any agent', async () => {
  const calls = []
  await assert.rejects(runDesign({}, { 'sh:setup': { output: 'EXIT=1' } }, calls), /intent/)
  assert.equal(calls.length, 1)
})

test('design: the judge never sees the angles, and pass 2 sees the reverse order', async () => {
  const { calls, byLabel } = await runDesign()
  const angles = calls.filter(c => c.opts.label.startsWith('design:')).map(c => c.prompt.match(/^ANGLE: (.*)$/m)[1])
  const [j1, j2] = [byLabel('judge:1')[0], byLabel('judge:2')[0]]
  for (const j of [j1, j2]) {
    assert.equal(j.opts.model, 'opus')
    for (const a of angles) assert.ok(!j.prompt.includes(a), 'judge prompt leaks an angle')
  }
  const order = p => [...p.matchAll(/designs\/(\d)\.md/g)].map(m => m[1])
  assert.deepEqual(order(j1.prompt), ['1', '2', '3'])
  assert.deepEqual(order(j2.prompt), ['3', '2', '1'])
})

test('design: agreeing passes pick the leader, and no design question is asked', async () => {
  const { result, byLabel } = await runDesign()
  assert.equal(result.leader, 1)
  assert.equal(result.judge.agree, true)
  assert.ok(!result.questions.some(q => q.id === 'design-choice'))
  assert.ok(byLabel('premortem')[0].prompt.includes('/designs/1.md'))
})

test('design: diverging passes turn the choice into a question', async () => {
  const { result } = await runDesign({}, { 'judge:2': { scores: [scored('A', 5), scored('B', 3), scored('C', 2)], winner: 'A', why: 'w' } })
  assert.equal(result.judge.agree, false)
  const q = result.questions.find(q => q.id === 'design-choice')
  assert.ok(q)
  assert.deepEqual(q.options.map(o => o.label).sort(), ['Design 1', 'Design 3'])
  assert.ok(q.header && q.header.length <= 12, 'AskUserQuestion needs a chip label')
})

test('design: a design whose stubs do not compile is not judged', async () => {
  const { byLabel, logs } = await runDesign({}, {
    'sh:compile:2': { output: 'error[E0412]\nEXIT=101' },
  })
  const p = byLabel('judge:1')[0].prompt
  assert.ok(!p.includes('designs/2.md'))
  assert.ok(logs.some(l => /design 2/.test(l)))
})

test('design: a compile run without an EXIT line is not judged', async () => {
  const { byLabel } = await runDesign({}, { 'sh:compile:3': { output: 'compiles fine' } })
  assert.ok(!byLabel('judge:1')[0].prompt.includes('designs/3.md'))
})

test('design: no compiling design is needs-human', async () => {
  const { result, calls, byLabel } = await runDesign({}, { 'sh:compile': { output: 'EXIT=1' } })
  assert.equal(result.status, 'needs-human')
  assert.equal(byLabel('sh:cleanup').length, 1)
  assert.equal(calls.filter(c => c.opts.label.startsWith('judge:')).length, 0)
})

test('design: a premortem mode without a test is dropped', async () => {
  const { result, byLabel } = await runDesign()
  assert.deepEqual(result.premortem.map(m => m.mode), ['BOUND-MODE'])
  const w = byLabel('sh:write:premortem')[0].prompt
  assert.ok(w.includes('BOUND-MODE') && !w.includes('UNBOUND-MODE'))
})

test('design: every agent label is unique, and next names decisions.md', async () => {
  const { calls, result } = await runDesign()
  const labels = calls.map(c => c.opts.label)
  assert.deepEqual(labels.filter((l, i) => labels.indexOf(l) !== i), [])
  assert.match(result.next, /decisions\.md/)
})

