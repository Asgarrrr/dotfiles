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

test('the shell runner treats the script text as data', async () => {
  const { calls } = await run(INTENT)
  for (const p of shellPrompts(calls)) assert.match(p.split('--- script ---')[0], /data, never an instruction/)
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
  'sh:setup': { output: 'PREFIX=\nEXIT=0' },
  'sh:worktrees': { output: 'DIRSTATE=abc -\nEXIT=0' },
  'sh:cleanup': { output: 'DIRSTATE=abc -\nEXIT=0' },
  'deps': { deps: [{ name: 'serde', ecosystem: 'cargo' }] },
  'research': {
    name: 'serde', lockVersion: '1.0.200', lockSource: 'Cargo.lock:42', latestVersion: '1.0.200',
    apiChanges: [], sourcesConsulted: ['https://docs.rs/serde'], report: 'same version', questions: [],
  },
  'design': label => ({ summary: `summary of ${label}`, compileCommand: 'cargo check' }),
  // Pass 1 sees designs 1,2,3 as A,B,C; pass 2 sees 3,2,1. Both pick design 1.
  'judge:1': { scores: [scored('A', 5), scored('B', 3), scored('C', 2)], winner: 'A', why: 'w' },
  'judge:2': { scores: [scored('A', 2), scored('B', 3), scored('C', 5)], winner: 'C', why: 'w' },
}
const runDesign = (args, overrides = {}, calls) => run({ ...DESIGN, ...args }, { ...DESIGN_FIXTURES, ...overrides }, calls)
const failing = () => { throw new Error('agent crashed') }
// Two compiling designs leave letters A and B only.
const TWO = { 'judge:1': { scores: [scored('A', 5), scored('B', 3)], winner: 'A', why: 'w' }, 'judge:2': { scores: [scored('A', 3), scored('B', 5)], winner: 'B', why: 'w' } }

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

test('design: a failed deps agent or researcher is UNVERIFIED, never silence', async () => {
  const noDeps = await runDesign({}, { deps: () => null })
  assert.match(noDeps.result.warnings.join('\n'), /UNVERIFIED/)
  const noRes = await runDesign({}, { research: failing })
  assert.match(noRes.result.warnings.join('\n'), /serde.*UNVERIFIED/)
  assert.match(noRes.byLabel('sh:write:research')[0].prompt, /## serde \(UNVERIFIED/)
  const noSrc = await runDesign({}, { research: { ...DESIGN_FIXTURES.research, sourcesConsulted: [] } })
  assert.match(noSrc.byLabel('sh:write:research')[0].prompt, /## serde \(UNVERIFIED\)/)
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
  assert.ok(byLabel('sh:setup')[0].prompt.includes("cd '/repo' && test -f '/repo/.claude/runs/add-thing/task.md'"))
  const wts = byLabel('sh:worktrees')[0].prompt
  ds.forEach((d, i) => {
    assert.ok(d.prompt.includes(`/designs/${i + 1}.md`))
    assert.ok(d.prompt.includes(`/repo/.claude/runs/add-thing/wt/${i + 1}`))
    assert.ok(wts.includes(`git worktree add -q --detach '/repo/.claude/runs/add-thing/wt/${i + 1}' HEAD`))
  })
  assert.ok(wts.includes('git worktree prune') && wts.indexOf('git worktree prune') < wts.indexOf('git worktree add'), 'a leaked worktree from an earlier run is cleared first')
})

test('design: the script compiles each design in its worktree, then removes every worktree', async () => {
  const { byLabel } = await runDesign({}, { 'sh:setup': { output: 'PREFIX=pkg/\nEXIT=0' } })
  const c2 = byLabel('sh:compile:2')[0].prompt
  assert.ok(c2.includes(`cd '/repo/.claude/runs/add-thing/wt/2/pkg/' && if test -z "$(git status --porcelain)"`), 'a worktree with no change holds no stub')
  assert.ok(c2.includes(`bash -c 'set -o pipefail; cargo check'`))
  assert.ok(byLabel('design:2')[0].prompt.includes('/wt/2/pkg/'))
  const rm = byLabel('sh:cleanup')[0].prompt
  for (const n of [1, 2, 3]) assert.ok(rm.includes(`git worktree remove --force '/repo/.claude/runs/add-thing/wt/${n}'`))
})

test('design: the worktrees are removed when a design agent or a compile throws', async () => {
  for (const o of [{ 'design:2': failing }, { 'sh:compile:1': failing }]) {
    const calls = []
    await runDesign({}, o, calls).catch(() => {})
    assert.equal(calls.filter(c => c.opts.label === 'sh:cleanup').length, 1, Object.keys(o)[0])
  }
  const calls = []
  await assert.rejects(runDesign({}, { 'sh:worktrees': { output: 'fatal: exists\nEXIT=128' } }, calls), /worktrees/)
  assert.equal(calls.filter(c => c.opts.label === 'sh:cleanup').length, 1)
})

test('design: a failed cleanup and a dir changed during the fan-out are warnings', async () => {
  const { result } = await runDesign({}, { 'sh:cleanup': { output: 'DIRSTATE=zzz -\nEXIT=1' } })
  const w = result.warnings.join('\n')
  assert.match(w, /not removed/)
  assert.match(w, /outside its worktree/)
  assert.deepEqual((await runDesign()).result.warnings, [])
})

test('design: a missing task.md stops the stage before any agent', async () => {
  const calls = []
  await assert.rejects(runDesign({}, { 'sh:setup': { output: 'EXIT=1' } }, calls), /intent/)
  assert.equal(calls.length, 1)
})

test('design: an empty compile command is not a pass', async () => {
  const { byLabel, result } = await runDesign({}, { ...TWO, 'design:2': { summary: 's', compileCommand: '  ' } })
  assert.equal(byLabel('sh:compile:2').length, 0)
  assert.ok(!byLabel('judge:1')[0].prompt.includes('designs/2.md'))
  assert.match(result.warnings.join('\n'), /design 2/)
})

test('design: the judge never sees the angles, and pass 2 sees the reverse order', async () => {
  const { calls, byLabel } = await runDesign()
  const angles = calls.filter(c => c.opts.label.startsWith('design:')).map(c => c.prompt.match(/^ANGLE: (.*)$/m)[1])
  const [j1, j2] = [byLabel('judge:1')[0], byLabel('judge:2')[0]]
  for (const j of [j1, j2]) {
    assert.equal(j.opts.model, 'opus')
    assert.deepEqual(j.opts.schema.properties.winner.enum, ['A', 'B', 'C'])
    for (const a of angles) assert.ok(!j.prompt.includes(a), 'judge prompt leaks an angle')
  }
  const order = p => [...p.matchAll(/designs\/(\d)\.md/g)].map(m => m[1])
  assert.deepEqual(order(j1.prompt), ['1', '2', '3'])
  assert.deepEqual(order(j2.prompt), ['3', '2', '1'])
})

test('design: a judge letter that maps to no design, or a design scored twice, is an error', async () => {
  const prose = { scores: [scored('Design A', 5), scored('Design B', 3), scored('Design C', 2)], winner: 'Design A', why: 'w' }
  await assert.rejects(runDesign({}, { 'judge:1': prose }), /exactly once/)
  const twice = { scores: [scored('A', 5), scored('A', 3), scored('C', 2)], winner: 'A', why: 'w' }
  await assert.rejects(runDesign({}, { 'judge:2': twice }), /exactly once/)
  const missing = { scores: [scored('A', 5), scored('B', 3)], winner: 'A', why: 'w' }
  await assert.rejects(runDesign({}, { 'judge:1': missing }), /exactly once/)
})

test('design: agreeing passes pick the leader, and no design question is asked', async () => {
  const { result } = await runDesign()
  assert.equal(result.leader, 1)
  assert.equal(result.judge.agree, true)
  assert.ok(!result.questions.some(q => q.id === 'design-choice'))
})

test('design: diverging passes ask the user between the two winners, ranked by total', async () => {
  // Pass 1 picks design 1 (A); pass 2 sees 3,2,1 and picks design 3 (A). Design 2 leads on totals but won no pass.
  const { result } = await runDesign({}, {
    'judge:1': { scores: [scored('A', 4), scored('B', 4), scored('C', 1)], winner: 'A', why: 'w1' },
    'judge:2': { scores: [scored('A', 3), scored('B', 4), scored('C', 2)], winner: 'A', why: 'w2' },
  })
  assert.equal(result.judge.agree, false)
  assert.equal(result.leader, null)
  const q = result.questions.find(q => q.id === 'design-choice')
  assert.deepEqual(q.options.map(o => o.label), ['Design 1', 'Design 3'])
  assert.equal(q.recommendation.option, 'Design 1', 'design 1 totals 36, design 3 totals 30')
  assert.ok(q.header && q.header.length <= 12, 'AskUserQuestion needs a chip label')
  assert.deepEqual(result.warnings, [], 'the recommendation names an option')
})

test('design: a tie between the two winners is reported, not broken by pass order', async () => {
  const { result } = await runDesign({}, { 'judge:2': { scores: [scored('A', 5), scored('B', 3), scored('C', 2)], winner: 'A', why: 'w' } })
  const q = result.questions.find(q => q.id === 'design-choice')
  assert.match(q.recommendation.why, /tie/)
})

test('design: a design whose stubs do not compile is not judged', async () => {
  const { byLabel, result } = await runDesign({}, { ...TWO, 'sh:compile:2': { output: 'error[E0412]\nEXIT=101' } })
  assert.ok(!byLabel('judge:1')[0].prompt.includes('designs/2.md'))
  assert.match(result.warnings.join('\n'), /design 2/)
})

test('design: a compile run without an EXIT line is not judged', async () => {
  const { byLabel } = await runDesign({}, { ...TWO, 'sh:compile:3': { output: 'compiles fine' } })
  assert.ok(!byLabel('judge:1')[0].prompt.includes('designs/3.md'))
})

test('design: no compiling design is needs-human, and keeps the research questions', async () => {
  const gap = { ...DESIGN_FIXTURES.research, questions: [question('serde-2')] }
  const { result, calls, byLabel } = await runDesign({}, { 'sh:compile': { output: 'EXIT=1' }, research: gap })
  assert.equal(result.status, 'needs-human')
  assert.deepEqual(result.questions.map(q => q.id), ['serde-2'])
  assert.equal(calls.filter(c => c.opts.label.startsWith('judge:')).length, 0)
  assert.equal(byLabel('sh:cleanup').length, 1)
})

test('design: shell lines quote every path under a dir with a single quote', async () => {
  const { calls } = await runDesign({ dir: "/it's my repo" })
  const scripts = shellPrompts(calls).map(p => p.split('--- script ---')[1])
  assert.ok(scripts.length > 5)
  for (const sc of scripts) {
    const rest = sc.replace(/<<'(\w+)'\n[\s\S]*?\n\1\n/g, '').replace(/'\/it'\\''s my repo[^']*'/g, 'Q')
    assert.ok(!rest.includes("it's my repo") && !rest.includes("/it'"), sc)
  }
})

test('design: every agent label is unique, and next names decisions.md', async () => {
  const { calls, result } = await runDesign()
  const labels = calls.map(c => c.opts.label)
  assert.deepEqual(labels.filter((l, i) => labels.indexOf(l) !== i), [])
  assert.match(result.next, /decisions\.md/)
})

// --- contract --------------------------------------------------------------

const CONTRACT = { ...BASE, stage: 'contract' }
const SLICE = (title, extra = {}) => ({ title, kind: 'implement', risk: 'low', gate: { command: 'npm test', budgetSec: 120 }, bricks: ['slugify'], ...extra })
const point = (id, extra = {}) => ({ id, claim: `claim ${id}`, evidence: 'e', severity: 'major', ...extra })
const answer = (id, verdict, proof, extra = {}) => ({ id, verdict, proof, checked: [], addsStructure: false, secondConsumer: '', changesDesign: false, ...extra })
const CONTRACT_FIXTURES = {
  'sh:branch': { output: 'BASE=abc1234\nEXIT=0' },
  'premortem': { framing: 'This design will succeed at slugs under any script.', modes: [
    { mode: 'Cyrillic dropped', trigger: 'slugify("й")', test: 'cyrillic: slugify("й") is not empty' },
    { mode: 'vague worry', trigger: 'someday', test: '' },
  ] },
  'contract': {
    bricks: [{ name: 'slugify', file: 'src/slug.js', claims: [{ claim: 'slugify is exported', ref: 'src/slug.js:1' }] }],
    compileCommand: 'node --check src/slug.js',
    suiteCommand: 'npm test', lintCommand: 'npm run lint', mutationCommand: '',
    slices: [SLICE('Accents'), SLICE('Drop chars', { risk: 'high' })], digest: 'contract digest',
  },
  'ground': { checks: [{ index: 1, claim: 'slugify is exported', ref: 'src/slug.js:1', verdict: 'true', excerpt: 'export function slugify' }] },
  'tests': { files: ['test/slug.test.js'], testCommand: 'npm test', commit: 'def5678' },
  'sh:tests:red': { output: '1 failing\nEXIT=1' },
  'sh:critique:gpt': { output: `--- answer ---\n${JSON.stringify({ points: [point('p1'), point('p2'), point('p3')] })}\n--- end answer ---\nEXIT=0` },
  'critique:answer': { answers: [
    answer('p1', 'accept', { kind: 'failing-test', ref: 'test/x.test.js', command: 'node --test x' }),
    answer('p2', 'accept', { kind: 'doc', ref: 'https://docs.example/x', command: '' }, { addsStructure: true }),
    answer('p3', 'reject', { kind: 'none', ref: '', command: '' }, { checked: ['src/slug.js:1 already trims'] }),
  ] },
  'sh:proof': { output: 'Error: expected\nEXIT=1' },
}
// The apply agent returns the whole contract after the fixes.
CONTRACT_FIXTURES['critique:apply'] = CONTRACT_FIXTURES.contract
const runContract = (args, overrides = {}, calls) => run({ ...CONTRACT, ...args }, { ...CONTRACT_FIXTURES, ...overrides }, calls)
const codexLines = calls => calls.flatMap(c => c.prompt.split('\n')).filter(l => l.includes('codex exec'))

test('contract: exactly one codex call, on gpt-6-astra at xhigh by default', async () => {
  const { calls } = await runContract()
  const lines = codexLines(calls)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /-m gpt-6-astra /)
  assert.match(lines[0], /model_reasoning_effort=xhigh/)
  // The codex line sits inside bash -c '…', so its own quotes are escaped once more.
  assert.ok(lines[0].includes(`-C '\\''/repo'\\'' `), lines[0])
})

test('contract: gpt sol switches tier, gpt false skips codex entirely', async () => {
  assert.match(codexLines((await runContract({ gpt: 'sol' })).calls)[0], /-m gpt-6-sol /)
  const off = await runContract({ gpt: false })
  assert.equal(codexLines(off.calls).length, 0)
  assert.equal(off.byLabel('critique:answer').length, 0)
  await assert.rejects(runContract({ gpt: 'gpt-4' }), /gpt/)
  await assert.rejects(runContract({ gpt: 'constructor' }), /gpt/)
})

test('contract: an exhausted GPT quota is the first warning, with no fallback critic', async () => {
  // An empty premortem warns first in time; the quota warning must still lead.
  const { result, calls } = await runContract({}, { premortem: null, 'sh:critique:gpt': { output: "ERROR: You've hit your usage limit.\nEXIT=1" } })
  assert.match(result.warnings[0], /quota/i)
  assert.equal(result.warnings.length, 2)
  assert.equal(calls.filter(c => c.opts.label.startsWith('critique:') && c.opts.label !== 'critique:gpt').length, 0)
})

test('contract: an accepted critique that adds structure without a second consumer is rejected and stays in the ledger', async () => {
  const { result, byLabel } = await runContract()
  const p2 = result.ledger.find(l => l.id === 'p2')
  assert.equal(p2.verdict, 'rejected')
  assert.match(p2.note, /second consumer/)
  const ledger = byLabel('sh:write:ledger')[0].prompt
  assert.ok(ledger.includes('claim p2'))
  assert.ok(ledger.includes('claim p1'), 'accepted critiques are in the ledger too')
})

test('contract: an accept without proof is unproven, and a reject must list what was checked', async () => {
  const { result, byLabel } = await runContract({}, {
    'critique:answer': { answers: [
      answer('p1', 'accept', { kind: 'failing-test', ref: 't', command: 'node --test t' }),
      answer('p2', 'accept', { kind: 'none', ref: '', command: '' }),
      answer('p3', 'reject', { kind: 'none', ref: '', command: '' }),
    ] },
    // The answer says p1 fails; rerun by the script, it passes.
    'sh:proof:p1': { output: 'ok\nEXIT=0' },
  })
  assert.deepEqual(result.ledger.map(l => l.verdict), ['unproven', 'unproven', 'unproven'])
  assert.ok(byLabel('sh:proof:p1')[0].prompt.includes(`bash -c 'set -o pipefail; node --test t'`))
  const missing = await runContract({}, { 'sh:proof:p1': { output: 'it fails, trust me' } })
  assert.equal(missing.result.ledger.find(l => l.id === 'p1').verdict, 'unproven')
  const noUrl = await runContract({}, { 'critique:answer': { answers: [answer('p1', 'accept', { kind: 'doc', ref: 'the README says so', command: '' })] } })
  assert.equal(noUrl.result.ledger.find(l => l.id === 'p1').verdict, 'unproven', 'a doc proof needs a URL')
})

test('contract: only proven accepts are applied, and a design change becomes a question', async () => {
  const { byLabel, result } = await runContract()
  const apply = byLabel('critique:apply')[0].prompt
  assert.ok(apply.includes('claim p1') && !apply.includes('claim p2') && !apply.includes('claim p3'))
  const changed = await runContract({}, { 'critique:answer': { answers: [
    answer('p1', 'accept', { kind: 'stub-compile', ref: 'src/a.rs', command: 'cargo check' }, { changesDesign: true }),
  ] } })
  assert.equal(changed.byLabel('critique:apply').length, 0)
  assert.equal(changed.result.status, 'questions')
  const q = changed.result.questions.find(q => q.id === 'critique-p1')
  assert.ok(q && q.header.length <= 12 && q.options.some(o => o.label === q.recommendation.option))
  assert.equal(result.status, 'ready')
})

test('contract: tests that pass against the stubs block the run', async () => {
  const { result } = await runContract({}, { 'sh:tests:red': { output: 'all passed\nEXIT=0' } })
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /green against the stubs/)
  const missing = await runContract({}, { 'sh:tests:red': { output: 'some failed' } })
  assert.equal(missing.result.status, 'blocked')
})

test('contract: the test-writer works from the contract alone, apart from the implementer', async () => {
  const { byLabel } = await runContract()
  const t = byLabel('tests')[0]
  assert.ok(t.prompt.includes('/contract/contract.md'))
  assert.ok(!t.prompt.includes('decisions.md') && !t.prompt.includes('/designs/') && !t.prompt.includes('Run dir'))
  assert.ok(t.prompt.includes('Read no other file under /repo/.claude/runs/add-thing.'))
  assert.notEqual(t.opts.agentType, 'implementer')
  // The build forbids edits to every listed file: a production file that only registers a test module must stay editable.
  assert.match(t.prompt, /files that hold tests only/)
  assert.ok(byLabel('sh:tests:red')[0].prompt.includes(`bash -c 'set -o pipefail; npm test'`))
})

test('contract: a false claim gets one revision, then needs-human', async () => {
  const bad = { checks: [{ index: 1, claim: 'slugify is exported', ref: 'src/slug.js:1', verdict: 'false', excerpt: 'function slugify' }] }
  const once = await runContract({}, { 'ground:1': bad })
  assert.equal(once.byLabel('contract:revise').length, 1)
  assert.ok(once.byLabel('contract:revise')[0].prompt.includes('src/slug.js:1): function slugify'))
  assert.equal(once.result.groundFalse, 1)
  const twice = await runContract({}, { ground: bad })
  assert.equal(twice.result.status, 'needs-human')
  assert.equal(twice.byLabel('tests').length, 0)
})

test('contract: the ground agent sees the claims, not the contract author reasoning', async () => {
  const { byLabel } = await runContract()
  const g = byLabel('ground:1')[0]
  assert.equal(g.opts.model, 'sonnet')
  assert.ok(g.prompt.includes('src/slug.js:1'))
  assert.ok(!g.prompt.includes('contract digest'))
})

test('contract: stubs that do not compile block, and so does a slice naming an unknown brick', async () => {
  assert.equal((await runContract({}, { 'sh:compile:contract': { output: 'SyntaxError\nEXIT=1' } })).result.status, 'blocked')
  assert.equal((await runContract({}, { 'sh:compile:applied': { output: 'EXIT=1' } })).result.status, 'blocked', 'the critique fixes are recompiled')
  const c = { ...CONTRACT_FIXTURES.contract, slices: [SLICE('x', { bricks: ['nope'] })] }
  const unknown = await runContract({}, { contract: c })
  assert.equal(unknown.result.status, 'blocked')
  assert.match(unknown.result.reason, /nope/)
})

test('contract: after the branch exists, an empty agent result blocks instead of throwing, and writes contract.json', async () => {
  for (const label of ['contract', 'critique:apply', 'tests']) {
    const { result, byLabel } = await runContract({}, { [label]: null, 'sh:branch': { output: 'BASE=abc1234\nFROM=main\nEXIT=0' } })
    assert.equal(result.status, 'blocked', label)
    assert.equal(result.from, 'main', label)
    assert.doesNotMatch(result.reason, /after creating/, `${label}: an empty result is handled, not caught`)
    assert.equal(byLabel('sh:write:result:contract').length, 1, label)
  }
  const revise = await runContract({}, { 'ground:1': { checks: [] }, 'contract:revise': null })
  assert.equal(revise.result.status, 'blocked')
})

test('contract: a claim the ground checker leaves out counts as false', async () => {
  for (const g of [null, { checks: [] }, { checks: [{ index: 2, claim: 'other', ref: 'src/slug.js:1', verdict: 'true', excerpt: '' }] }]) {
    const { byLabel, result } = await runContract({}, { 'ground:1': g })
    assert.equal(byLabel('contract:revise').length, 1, JSON.stringify(g))
    assert.equal(result.groundFalse, 1)
  }
})

test('contract: slices.json carries the base, the commands and the slices', async () => {
  const { byLabel } = await runContract()
  const w = byLabel('sh:write:slices')[0].prompt
  const json = JSON.parse(w.split("<<'FEATURE_EOF'\n")[1].split('\nFEATURE_EOF')[0])
  assert.equal(json.base, 'abc1234')
  assert.equal(json.suite, 'npm test')
  assert.equal(json.slices.length, 2)
})

test('contract: a branch that already exists is refused, and the stage never runs on main', async () => {
  const { byLabel } = await runContract()
  const b = byLabel('sh:branch')[0].prompt
  assert.ok(b.includes("git switch -c 'feature/add-thing'"))
  assert.ok(b.includes("test -f '/repo/.claude/runs/add-thing/decisions.md'"))
  assert.ok(b.includes('test -z "$(git status --porcelain)"'), 'a dirty tree would ride into the stub commit')
  assert.equal((await runContract({}, { 'sh:branch': { output: 'fatal: already exists\nEXIT=128' } })).result.status, 'blocked')
})

test('contract: a gate budget above the Bash tool limit is clamped, with a warning', async () => {
  const c = { ...CONTRACT_FIXTURES.contract, slices: [SLICE('Slow', { gate: { command: 'npm test', budgetSec: 3600 } })] }
  const { result } = await runContract({ gpt: false }, { contract: c })
  assert.equal(result.slices[0].gate.budgetSec, 570)
  assert.match(result.warnings.join('\n'), /clamped/)
  const low = { ...CONTRACT_FIXTURES.contract, slices: [SLICE('Neg', { gate: { command: 'npm test', budgetSec: -5 } })] }
  assert.equal((await runContract({ gpt: false }, { contract: low })).result.slices[0].gate.budgetSec, 570)
})

test('contract: slices.json comes from the contract after the critique fixes', async () => {
  const fixed = { ...CONTRACT_FIXTURES.contract, slices: [SLICE('Fixed', { gate: { command: 'npm run test:fixed', budgetSec: 60 } })] }
  const { byLabel } = await runContract({}, { 'critique:apply': fixed })
  const w = byLabel('sh:write:slices')[0].prompt
  assert.ok(w.includes('npm run test:fixed'))
  assert.ok(byLabel('sh:compile:applied')[0].prompt.includes('node --check src/slug.js'))
})

test('contract: a proof is rerun after its fix and must pass, or the run warns', async () => {
  const ok = await runContract()
  assert.equal(ok.byLabel('sh:recheck:p1').length, 1)
  const at = l => ok.calls.findIndex(c => c.opts.label === l)
  assert.ok(at('sh:recheck:p1') > at('critique:apply'), 'the recheck runs after the fix')
  assert.ok(ok.byLabel('sh:recheck:p1')[0].prompt.includes(`bash -c 'set -o pipefail; node --test x'`))
  assert.equal(ok.byLabel('sh:recheck:p2').length, 0, 'a doc proof has nothing to rerun')
  assert.equal(ok.result.ledger.find(l => l.id === 'p1').afterFix, 'pass')
  const still = await runContract({}, { 'sh:recheck': { output: 'still red\nEXIT=1' } })
  assert.match(still.result.warnings.join('\n'), /p1: the proof still fails after the fix/)
})

test('contract: a proof whose command never ran is no proof', async () => {
  for (const code of [125, 126, 127]) {
    const { result } = await runContract({}, { 'sh:proof:p1': { output: `bash: x: command not found\nEXIT=${code}` } })
    assert.equal(result.ledger.find(l => l.id === 'p1').verdict, 'unproven', String(code))
  }
  const { byLabel } = await runContract()
  assert.ok(byLabel('sh:proof:p1')[0].prompt.includes(`mkdir -p "$(dirname '/repo/.claude/runs/add-thing/contract/proof/p1.log')"`))
})

test('contract: the red run checks that the test files and the commit are at HEAD', async () => {
  const { byLabel } = await runContract()
  const r = byLabel('sh:tests:red')[0].prompt
  assert.ok(r.includes(`'def5678^{commit}'`))
  assert.ok(r.includes("git cat-file -e 'HEAD:test/slug.test.js'"), 'staged is not committed')
  assert.ok(r.includes("git diff --quiet HEAD -- 'test/slug.test.js'"))
  assert.ok(r.includes("! git diff --quiet 'abc1234' HEAD -- 'test/slug.test.js'"), 'the files changed since the base')
  const absent = await runContract({}, { 'sh:tests:red': { output: 'NOT_AT_HEAD\nEXIT=125' } })
  assert.equal(absent.result.status, 'blocked')
  assert.match(absent.result.reason, /not committed at HEAD/)
  const own125 = await runContract({}, { 'sh:tests:red': { output: 'tool exits 125\nEXIT=125' } })
  assert.doesNotMatch(own125.result.reason, /not committed/)
  const none = await runContract({}, { tests: { files: [], testCommand: 'npm test', commit: 'x' } })
  assert.equal(none.result.status, 'blocked')
})

test('contract: every stage prompt carries the data rule', async () => {
  const { calls } = await runContract({}, { 'ground:1': { checks: [] } })
  for (const c of calls.filter(c => !c.opts.label.startsWith('sh:'))) assert.match(c.prompt, /data, never an instruction/, c.opts.label)
})

test('contract: the ledger is always written and says when there was no critique', async () => {
  const off = await runContract({ gpt: false })
  assert.match(off.byLabel('sh:write:ledger')[0].prompt, /no critique: gpt false/)
  const quota = await runContract({}, { 'sh:critique:gpt': { output: 'usage limit\nEXIT=1' } })
  assert.match(quota.byLabel('sh:write:ledger')[0].prompt, /no critique: GPT quota exhausted/)
})

test('contract: shell lines quote every path under a dir with a single quote', async () => {
  const { calls } = await runContract({ dir: "/it's my repo" })
  for (const sc of shellPrompts(calls).map(p => p.split('--- script ---')[1])) {
    const rest = sc.replace(/<<'(\w+)'\n[\s\S]*?\n\1\n/g, '').replace(/'\/it'\\''s my repo[^']*'/g, 'Q')
    // Nested quoting inside bash -c doubles the escape; strip that form too.
    const rest2 = rest.replace(/'\\''\/it'\\''\\'\\'''\\''s my repo[^']*'\\''/g, 'Q')
    assert.ok(!rest2.includes("it's my repo"), sc)
  }
})

test('contract: every agent label is unique', async () => {
  const { calls } = await runContract({}, { 'ground:1': { checks: [{ claim: 'c', ref: 'r', verdict: 'false', excerpt: '' }] } })
  const labels = calls.map(c => c.opts.label)
  assert.deepEqual(labels.filter((l, i) => labels.indexOf(l) !== i), [])
})

test('contract: the premortem runs on the chosen design, and a mode without a test is dropped', async () => {
  const { byLabel, result, logs } = await runContract()
  const pm = byLabel('premortem')[0]
  assert.ok(pm.prompt.includes('/repo/.claude/runs/add-thing/decisions.md'))
  assert.equal(pm.opts.model, 'opus')
  const md = byLabel('sh:write:premortem')[0].prompt
  assert.ok(md.includes('cyrillic: slugify'))
  assert.ok(!md.includes('vague worry'))
  assert.deepEqual(result.premortem.map(m => m.mode), ['Cyrillic dropped'])
  assert.match(logs.join('\n'), /1 mode\(s\) without a test dropped/)
  assert.ok(byLabel('contract')[0].prompt.includes('/premortem.md'), 'the contract reads the premortem')
  assert.match(byLabel('contract')[0].prompt, /gate command that runs its tests only: no scope or diff check/, 'the final gate reruns every slice gate after the fix')
  assert.match(byLabel('contract')[0].prompt, /every field the build adds, private ones included/, 'a test that builds a struct must compile against its final shape')
  assert.match(byLabel('contract')[0].prompt, /No slice edits a test file/)
  assert.match(byLabel('contract')[0].prompt, /never selects a test that a later slice makes pass/, 'a name filter that matches a later test blocks the slice')
  assert.ok(byLabel('tests')[0].prompt.includes('/premortem.md'), 'the test-writer binds the premortem tests')
})

test('contract: a premortem that returns nothing is a warning, not a crash', async () => {
  const { result } = await runContract({}, { premortem: null })
  assert.match(result.warnings.join('\n'), /premortem/)
  assert.deepEqual(result.premortem, [])
})

test('contract: a blocked branch runs no premortem', async () => {
  const { byLabel } = await runContract({}, { 'sh:branch': { output: 'EXIT=1' } })
  assert.equal(byLabel('premortem').length, 0)
})

test('contract: two claims at one ref are checked apart', async () => {
  const two = { ...CONTRACT_FIXTURES.contract, bricks: [{ name: 'slugify', file: 'src/slug.js', claims: [
    { claim: 'slugify is exported', ref: 'src/slug.js:1' }, { claim: 'slugify trims input', ref: 'src/slug.js:1' }] }] }
  const g = { checks: [
    { index: 1, claim: 'slugify is exported', ref: 'src/slug.js:1', verdict: 'true', excerpt: 'export' },
    { index: 2, claim: 'slugify trims input', ref: 'src/slug.js:1', verdict: 'false', excerpt: 'no trim' }] }
  const { byLabel, result } = await runContract({}, { contract: two, 'ground:1': g })
  assert.equal(result.groundFalse, 1)
  assert.ok(byLabel('contract:revise')[0].prompt.includes('slugify trims input (src/slug.js:1): no trim'))
  assert.ok(byLabel('ground:1')[0].prompt.includes('2. slugify trims input (src/slug.js:1)'))
})

test('contract: the claims are grounded again after the critique fixes', async () => {
  const bad = { checks: [{ index: 1, claim: 'slugify is exported', ref: 'src/slug.js:1', verdict: 'false', excerpt: '' }] }
  const { result } = await runContract({}, { 'ground:3': bad })
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /after the critique fixes, the contract relies on false claims/)
})

test('contract: an empty compile command blocks', async () => {
  const { result } = await runContract({}, { contract: { ...CONTRACT_FIXTURES.contract, compileCommand: ' ' } })
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /compile command is empty/)
})

test('contract: a failure after the branch exists returns blocked with the branch to go back to', async () => {
  const { result } = await runContract({}, { 'sh:branch': { output: 'BASE=abc1234\nFROM=main\nEXIT=0' }, 'sh:write:premortem': { output: 'disk full' } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.from, 'main')
  assert.match(result.reason, /after creating feature\/add-thing/)
  const noWrite = await runContract({}, { 'sh:write': { output: 'disk full' } })
  assert.equal(noWrite.result.status, 'blocked')
  assert.match(noWrite.result.warnings.join('\n'), /contract.json not written/)
})

test('contract: GPT point ids that are unsafe or repeated are renumbered', async () => {
  const unsafe = await runContract({}, { 'sh:critique:gpt': { output: `--- answer ---\n${JSON.stringify({ points: [point('../../x')] })}\n--- end answer ---\nEXIT=0` } })
  assert.ok(unsafe.byLabel('critique:answer')[0].prompt.includes('- p1 [major] claim ../../x'))
  const pts = [point('../../x'), point('p2'), point('p2')]
  const { byLabel } = await runContract({}, { 'sh:critique:gpt': { output: `--- answer ---\n${JSON.stringify({ points: pts })}\n--- end answer ---\nEXIT=0` } })
  const ask = byLabel('critique:answer')[0].prompt
  assert.ok(ask.includes('- p1 [major] claim ../../x') && ask.includes('- p3 [major] claim p2'))
  assert.ok(!byLabel('sh:proof:../../x').length)
})

test('contract: an absolute test path under the repo is checked relative to it', async () => {
  const { byLabel, result } = await runContract({}, { tests: { files: ['/repo/test/slug.test.js'], testCommand: 'npm test', commit: 'def5678' } })
  assert.ok(byLabel('sh:tests:red')[0].prompt.includes("git cat-file -e 'HEAD:test/slug.test.js'"))
  assert.deepEqual(result.tests.files, ['test/slug.test.js'])
})

// --- build -----------------------------------------------------------------

const BUILD = { ...BASE, stage: 'build' }
const CONTRACT_JSON = { stage: 'contract', status: 'ready', branch: 'feature/add-thing', base: 'abc1234', groundFalse: 0, ledger: [], tests: { files: ['test/slug.test.js'], command: 'npm test', commit: 'def5678' } }
const SLICES_JSON = {
  branch: 'feature/add-thing', base: 'abc1234', compile: 'node --check src/slug.js', suite: 'npm test', lint: 'npm run lint',
  mutation: 'npx stryker run --diff DIFF', slices: [SLICE('Accents', { gate: { command: 'node --test test/a.test.js', budgetSec: 120 } }), SLICE('Drop chars', { risk: 'high', gate: { command: 'node --test test/b.test.js', budgetSec: 60 } })],
}
const INTENT_JSON = { stage: 'intent', baseline: { command: 'npm test', lint: '', runs: ['pass', 'pass'], flaky: false } }
const files = ({ contract = CONTRACT_JSON, slices = SLICES_JSON, intent = INTENT_JSON, build } = {}) =>
  [['contract', contract], ['slices', slices], ['intent', intent], ...(build ? [['build', build]] : [])].map(([k, v]) => `--- ${k} ---\n${JSON.stringify(v)}\n\n--- end ${k} ---`).join('\n')
const preflight = (o = {}) => ({ output: `BRANCH=${o.branch || 'feature/add-thing'}\nHEAD=h0\nPREFIX=\n${files(o)}\nEXIT=0` })
const IMPL = { status: 'done', reason: '', evidence: [], decisions: ['IMPL-SECRET used NFD'], measure: '', invalidated: false }
const BUILD_FIXTURES = {
  'sh:preflight': preflight(),
  'impl': IMPL,
  'sh:check': label => ({ output: `HEAD=head-${label}\nEXIT=0` }),
  'peer': { findings: [] },
  'review': { findings: [] },
  'redteam': { findings: [] },
  'fix': { applied: [], declined: [] },
  'retro': { adr: 'docs/adr/0001-add-thing.md', commit: 'aaa1111', rules: [{ rule: 'r', where: 'CLAUDE.md', why: 'slice 2 retried' }] },
}
const runBuild = (args, overrides = {}, calls) => run({ ...BUILD, ...args }, { ...BUILD_FIXTURES, ...overrides }, calls)
const nonShell = calls => calls.filter(c => !c.opts.label.startsWith('sh:'))

test('build: a clean run builds every slice in order, gates each, and ends ready', async () => {
  const { calls, result, byLabel } = await runBuild()
  assert.equal(result.status, 'ready', JSON.stringify(result))
  const labels = calls.map(c => c.opts.label)
  const at = l => labels.indexOf(l)
  assert.ok(at('impl:1') < at('sh:gate:1') && at('sh:gate:1') < at('sh:lint:1') && at('sh:lint:1') < at('peer:1') && at('peer:1') < at('impl:2'), labels.join(' '))
  assert.ok(byLabel('sh:gate:2')[0].prompt.includes('node --test test/b.test.js'))
  assert.ok(byLabel('sh:gate:1')[0].prompt.includes('perl -e') && byLabel('sh:gate:1')[0].prompt.includes(' 120 bash -c'))
  assert.ok(at('retro') > at('sh:final:suite'))
  assert.ok(byLabel('sh:write:result:build').length === 1)
  assert.deepEqual(result.slices.map(s => s.decisions), [['IMPL-SECRET used NFD'], ['IMPL-SECRET used NFD']], 'micro-decisions are reported')
})

test('build: preflight blocks on a dirty tree, another branch, a contract not ready, or an unknown baseline', async () => {
  const dirty = await runBuild({}, { 'sh:preflight': { output: 'EXIT=1' } })
  assert.equal(dirty.result.status, 'blocked')
  assert.ok(!dirty.byLabel('impl:1').length)
  assert.match(dirty.byLabel('sh:preflight')[0].prompt, /test -z "\$\(git status --porcelain\)"/)
  const main = await runBuild({}, { 'sh:preflight': preflight({ branch: 'main' }) })
  assert.equal(main.result.status, 'blocked')
  assert.match(main.result.reason, /feature\/add-thing/)
  const notReady = await runBuild({}, { 'sh:preflight': preflight({ contract: { ...CONTRACT_JSON, status: 'blocked' } }) })
  assert.equal(notReady.result.status, 'blocked')
  const noBase = await runBuild({}, { 'sh:preflight': preflight({ intent: { stage: 'intent', baseline: { command: '', runs: [], flaky: false } } }) })
  assert.equal(noBase.result.status, 'blocked')
  assert.match(noBase.result.reason, /baseline/)
  const garbled = await runBuild({}, { 'sh:preflight': { output: 'BRANCH=feature/add-thing\nHEAD=h0\n--- contract ---\n{nope\n--- end contract ---\nEXIT=0' } })
  assert.equal(garbled.result.status, 'blocked')
})

test('build: a baseline that was not green is a warning', async () => {
  const { result } = await runBuild({}, { 'sh:preflight': preflight({ intent: { stage: 'intent', baseline: { command: 'npm test', runs: ['fail', 'fail'], flaky: false } } }) })
  assert.match(result.warnings.join('\n'), /baseline/)
})

test('build: the slice-2 implementer prompt does not depend on what slice 1 returned', async () => {
  const a = await runBuild()
  const b = await runBuild({}, { 'impl:1': { ...IMPL, decisions: ['something else'] }, 'sh:check:1': { output: 'HEAD=zzz9999\nEXIT=0' } })
  assert.equal(a.byLabel('impl:2')[0].prompt, b.byLabel('impl:2')[0].prompt)
  assert.ok(!a.byLabel('impl:2')[0].prompt.includes('head-sh:check:1'))
})

const PREV = { stage: 'build', status: 'blocked', at: 1,
  slices: [{ index: 0, title: 'Accents', head: 'slice1head', retried: true, decisions: ['kept NFD'] }],
  findings: [{ id: 'peer-1-1', source: 'peer:1', slice: 0, claim: 'error lost', evidence: 'src/slug.js:9', severity: 'major' }, { id: 'correctness-1', source: 'review:correctness', claim: 'stale', evidence: 'src/slug.js:2', severity: 'minor' }] }
const resume = (from, o = {}) => runBuild({ from }, { 'sh:preflight': preflight({ build: PREV }), fix: { applied: ['peer-1-1'], declined: [] }, ...o })

test('build: slice 1 starts at the test-writer commit, not at the HEAD of the rerun', async () => {
  const { byLabel } = await runBuild()
  assert.match(byLabel('sh:check:1')[0].prompt, /"\$\(git rev-parse 'def5678'\)"/)
  assert.match(byLabel('peer:1')[0].prompt, /git diff 'def5678' 'head-sh:check:1'/)
})

test('build: from resumes after the head the last build recorded, with its slices and slice findings', async () => {
  const { byLabel, result } = await resume(1)
  assert.ok(!byLabel('impl:1').length && byLabel('impl:2').length === 1)
  assert.match(byLabel('sh:check:2')[0].prompt, /'slice1head'/)
  assert.match(byLabel('peer:2')[0].prompt, /git diff 'slice1head' /)
  assert.deepEqual(result.slices.map(s => s.title), ['Accents', 'Drop chars'])
  const fix = byLabel('fix')[0].prompt
  assert.ok(fix.includes('peer-1-1') && !fix.includes('stale'), 'slice findings carry over; review findings are redone')
  assert.match(byLabel('retro')[0].prompt, /kept NFD/)
})

test('build: a resume after the fix does not send the applied findings again', async () => {
  const done = { ...PREV, at: 2, slices: [...PREV.slices, { index: 1, title: 'Drop chars', head: 'slice2head', retried: false, decisions: [] }],
    findings: [{ ...PREV.findings[0], outcome: 'applied' }, { id: 'mut-2', source: 'mutation', slice: 1, claim: 'm', evidence: 'x', severity: 'major', outcome: 'open' }] }
  const { byLabel, result } = await runBuild({ from: 2 }, { 'sh:preflight': preflight({ build: done }), fix: { applied: ['mut-2'], declined: [] } })
  const fix = byLabel('fix')[0].prompt
  assert.ok(fix.includes('mut-2') && !fix.includes('peer-1-1'), fix)
  assert.match(fix, /A red-team finding counts as applied only when its test stays committed at that path; if it cannot stay, decline it/)
  assert.deepEqual(result.findings.map(f => f.outcome), ['applied', 'applied'])
  const settled = await runBuild({ from: 2 }, { 'sh:preflight': preflight({ build: { ...done, findings: [done.findings[0]] } }) })
  assert.equal(settled.byLabel('fix').length, 0, 'nothing pending: no fix agent')
  assert.equal(settled.result.status, 'ready')
})

test('build: a peer finding records its slice, so a resume can carry it', async () => {
  const { result } = await runBuild({}, { 'peer:2': { findings: [{ claim: 'p', evidence: 'src/slug.js:4', severity: 'minor' }] }, fix: { applied: ['peer-2-1'], declined: [] } })
  assert.equal(result.findings[0].slice, 1)
})

test('build: from past the last slice runs only the review, and a from without its record blocks', async () => {
  const prev = { ...PREV, slices: [...PREV.slices, { index: 1, title: 'Drop chars', head: 'slice2head', retried: false, decisions: [] }] }
  const review = await runBuild({ from: 2 }, { 'sh:preflight': preflight({ build: prev }), fix: { applied: ['peer-1-1'], declined: [] } })
  assert.ok(!review.calls.some(c => c.opts.label.startsWith('impl:')))
  assert.equal(review.result.status, 'ready')
  assert.deepEqual(review.result.slices.map(s => s.head), ['slice1head', 'slice2head'])
  const none = await runBuild({ from: 1 })
  assert.equal(none.result.status, 'blocked')
  assert.match(none.result.reason, /from: 0/)
  assert.equal(none.result.at, 1)
  await assert.rejects(runBuild({ from: 3 }, { 'sh:preflight': preflight({ build: prev }) }), /from/)
  await assert.rejects(runBuild({ from: -1 }), /from/)
})

test('build: an early block returns at and keeps build.json, the record a resume reads', async () => {
  const { result, byLabel } = await runBuild({}, { 'sh:preflight': { output: 'EXIT=1' } })
  assert.equal(result.at, 0)
  assert.equal(byLabel('sh:write:result:build').length, 0)
  const noRecord = await runBuild({ from: 1 })
  assert.equal(noRecord.byLabel('sh:write:result:build').length, 0)
})

test('build: a stop whose write fails keeps its status and reason', async () => {
  const { result } = await runBuild({}, { 'impl:1': { ...IMPL, status: 'needs-human', reason: 'R-SECRET' }, 'sh:write:result:build': { output: 'EXIT=1' } })
  assert.equal(result.status, 'needs-human')
  assert.equal(result.reason, 'R-SECRET')
  assert.match(result.warnings.join('\n'), /build.json not written/)
})

test('build: the fix check needs a commit only for a pending finding applied, not a settled id echoed', async () => {
  const done = { ...PREV, at: 2, slices: [...PREV.slices, { index: 1, title: 'Drop chars', head: 'slice2head', retried: false, decisions: [] }],
    findings: [{ ...PREV.findings[0], outcome: 'applied' }, { id: 'mut-2', source: 'mutation', slice: 1, claim: 'm', evidence: 'x', severity: 'major' }] }
  const { byLabel } = await runBuild({ from: 2 }, { 'sh:preflight': preflight({ build: done }), fix: { applied: ['peer-1-1'], declined: [{ id: 'mut-2', why: 'src/a.js:1' }] } })
  assert.doesNotMatch(byLabel('sh:check:fix')[0].prompt, /NO_COMMIT/)
})

test('build: the implementer is sonnet only for a low-risk slice of a complete contract', async () => {
  const { byLabel } = await runBuild()
  assert.equal(byLabel('impl:1')[0].opts.model, 'sonnet')
  assert.equal(byLabel('impl:2')[0].opts.model, 'opus')
  assert.equal(byLabel('impl:1')[0].opts.agentType, 'implementer')
  const grounded = await runBuild({}, { 'sh:preflight': preflight({ contract: { ...CONTRACT_JSON, groundFalse: 1 } }) })
  assert.equal(grounded.byLabel('impl:1')[0].opts.model, 'opus')
  const unproven = await runBuild({}, { 'sh:preflight': preflight({ contract: { ...CONTRACT_JSON, ledger: [{ id: 'p1', verdict: 'unproven' }] } }) })
  assert.equal(unproven.byLabel('impl:1')[0].opts.model, 'opus')
})

test('build: the implementer starts from git status, keeps off the test-writer files, and commits once', async () => {
  const p = (await runBuild()).byLabel('impl:1')[0].prompt
  assert.match(p, /git status/)
  assert.ok(p.includes('test/slug.test.js'))
  assert.match(p, /If one of them is wrong, stop with status needs-human/)
  assert.match(p, /one commit/)
})

test('build: the check refuses a dirty tree, no new commit, or changed test-writer files', async () => {
  const chk = (await runBuild()).byLabel('sh:check:1')[0].prompt
  assert.ok(chk.includes("git diff --quiet 'def5678' HEAD -- 'test/slug.test.js'"), chk)
  assert.match(chk, /git status --porcelain/)
})

test('build: EXIT=142 is TIMEOUT and gets one retry on opus with the log tail', async () => {
  const { byLabel, result } = await runBuild({}, { 'sh:gate:1': { output: 'slow test\nEXIT=142' }, 'sh:gate:1:retry': { output: 'EXIT=0' } })
  const re = byLabel('impl:1:retry')
  assert.equal(re.length, 1)
  assert.equal(re[0].opts.model, 'opus')
  assert.match(re[0].prompt, /TIMEOUT/)
  assert.ok(re[0].prompt.includes('slow test'))
  assert.equal(byLabel('sh:gate:1:retry').length, 1)
  assert.equal(result.status, 'ready')
  assert.equal(result.slices[0].retried, true)
})

test('build: a missing EXIT line is a failure, and a second failure blocks and stops the run', async () => {
  const { byLabel, result } = await runBuild({}, { 'sh:gate:1': { output: 'all good, trust me' } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.at, 0)
  assert.match(result.reason, /missing/)
  assert.ok(!byLabel('impl:2').length, 'the run stops at the blocked slice')
  assert.ok(!byLabel('retro').length)
})

test('build: a failing lint fails the slice, and a failing check retries before the gate runs', async () => {
  const lint = await runBuild({}, { 'sh:lint:1': { output: 'unused export\nEXIT=1' } })
  assert.equal(lint.byLabel('impl:1:retry').length, 1)
  assert.match(lint.byLabel('impl:1:retry')[0].prompt, /lint/)
  const chk = await runBuild({}, { 'sh:check:1': { output: 'HEAD=h0\nTESTS_CHANGED\nEXIT=3' } })
  assert.ok(!chk.byLabel('sh:gate:1').length)
  assert.match(chk.byLabel('impl:1:retry')[0].prompt, /TESTS_CHANGED|test-writer/)
})

test('build: no lint command skips the lint with a warning', async () => {
  const { byLabel, result } = await runBuild({}, { 'sh:preflight': preflight({ slices: { ...SLICES_JSON, lint: '' } }) })
  assert.ok(!byLabel('sh:lint:1').length)
  assert.match(result.warnings.join('\n'), /lint/)
})

test('build: needs-human from the implementer stops the run with its evidence', async () => {
  const { byLabel, result } = await runBuild({}, { 'impl:1': { ...IMPL, status: 'needs-human', reason: 'test asserts the wrong thing', evidence: ['test/slug.test.js:3'] } })
  assert.equal(result.status, 'needs-human')
  assert.deepEqual(result.evidence, ['test/slug.test.js:3'])
  assert.ok(!byLabel('sh:gate:1').length)
})

test('build: an invalidated experiment stops the run and returns the measure', async () => {
  const sl = { ...SLICES_JSON, slices: [SLICE('Try NFKD', { kind: 'experiment', hypothesis: 'NFKD keeps ligatures under 1ms' }), SLICES_JSON.slices[1]] }
  const { byLabel, result } = await runBuild({}, { 'sh:preflight': preflight({ slices: sl }), 'impl:1': { ...IMPL, measure: '4ms per call', invalidated: true } })
  assert.equal(result.status, 'invalidated')
  assert.match(JSON.stringify(result), /4ms per call/)
  assert.ok(byLabel('impl:1')[0].prompt.includes('NFKD keeps ligatures under 1ms'))
  assert.ok(!byLabel('impl:2').length)
})

test('build: a high-risk slice runs mutation on its own diff, and a survivor becomes a finding', async () => {
  const { byLabel, result } = await runBuild({}, { 'sh:mutation:2': { output: '3 survived\nEXIT=2' } })
  assert.ok(!byLabel('sh:mutation:1').length, 'low risk runs no mutation')
  const m = byLabel('sh:mutation:2')[0].prompt
  assert.ok(m.includes("git diff 'head-sh:check:1' 'head-sh:check:2' >"), m)
  assert.ok(!/--diff DIFF/.test(m), 'DIFF is replaced by the diff file')
  assert.match(byLabel('fix')[0].prompt, /mut-2/)
  assert.ok(result.findings.some(f => f.id === 'mut-2'))
})

test('build: a mutation command without DIFF, or one that does not run, is a warning, not a finding', async () => {
  const noDiff = await runBuild({}, { 'sh:preflight': preflight({ slices: { ...SLICES_JSON, mutation: 'npx stryker run' } }) })
  assert.ok(!noDiff.byLabel('sh:mutation:2').length)
  assert.match(noDiff.result.warnings.join('\n'), /DIFF/)
  const broken = await runBuild({}, { 'sh:mutation:2': { output: 'command not found\nEXIT=127' } })
  assert.ok(!broken.result.findings.length)
  assert.match(broken.result.warnings.join('\n'), /mutation/)
})

test('build: peer and review never see the implementer text', async () => {
  const { calls } = await runBuild({}, { 'impl': { ...IMPL, reason: 'IMPL-SECRET reason', measure: 'IMPL-SECRET measure' } })
  const blind = calls.filter(c => /^(peer|review|redteam)/.test(c.opts.label))
  assert.ok(blind.length >= 7, blind.map(c => c.opts.label).join(' '))
  for (const c of blind) assert.ok(!c.prompt.includes('IMPL-SECRET'), c.opts.label)
  assert.equal(calls.find(c => c.opts.label === 'peer:1').opts.agentType, 'reviewer')
  assert.ok(calls.find(c => c.opts.label === 'peer:2').prompt.includes("git diff 'head-sh:check:1' 'head-sh:check:2'"))
})

test('build: four read-only review lenses run on the whole branch', async () => {
  const { byLabel } = await runBuild()
  for (const lens of ['correctness', 'minimality', 'conformity', 'security']) {
    const r = byLabel(`review:${lens}`)
    assert.equal(r.length, 1, lens)
    assert.ok(r[0].prompt.includes("git diff 'abc1234' HEAD"), lens)
  }
  assert.match(byLabel('review:minimality')[0].prompt, /does not require/)
})

test('build: a finding without path:line evidence is dropped', async () => {
  const { byLabel, result } = await runBuild({}, {
    'review:correctness': { findings: [{ claim: 'off by one', evidence: 'src/slug.js:12', severity: 'major' }, { claim: 'feels wrong', evidence: 'vibes', severity: 'major' }] },
  })
  const fix = byLabel('fix')[0].prompt
  assert.ok(fix.includes('off by one') && !fix.includes('feels wrong'))
  assert.equal(result.findings.length, 1)
})

test('build: a red-team finding is kept only when its test runs to a failure', async () => {
  const red = { findings: [
    { claim: 'empty string crashes', test: 'test/red1.test.js', command: 'node --test test/red1.test.js', severity: 'major' },
    { claim: 'passes anyway', test: 'test/red2.test.js', command: 'node --test test/red2.test.js', severity: 'major' },
    { claim: 'never ran', test: 'test/red3.test.js', command: 'nodee --test', severity: 'major' },
  ] }
  const { byLabel, result } = await runBuild({}, {
    'redteam': red,
    'sh:redteam:red-1': { output: 'AssertionError\nEXIT=1' },
    'sh:redteam:red-2': { output: 'ok\nEXIT=0' },
    'sh:redteam:red-3': { output: 'not found\nEXIT=127' },
    'fix': { applied: ['red-1'], declined: [] },
  })
  assert.ok(byLabel('sh:redteam:red-1')[0].prompt.includes("cd '/repo/.claude/runs/add-thing/wt/redteam'"))
  const fix = byLabel('fix')[0].prompt
  assert.ok(fix.includes('empty string crashes') && !fix.includes('passes anyway') && !fix.includes('never ran'))
  assert.deepEqual(result.findings.map(f => f.id), ['red-1'])
  assert.ok(byLabel('sh:final:red:red-1')[0].prompt.includes("cd '/repo' && "), 'the ported red test reruns in the repo')
  assert.match(byLabel('redteam')[0].prompt, /Never write in \/repo/)
})

test('build: a step that throws ends blocked at its slice, and the red-team worktree is still removed', async () => {
  const { calls, result } = await runBuild({}, { 'review:correctness': { findings: [{ claim: 'c', evidence: 'src/slug.js:1', severity: 'major' }] }, 'fix': failing })
  assert.equal(result.status, 'blocked')
  assert.equal(result.at, 2)
  assert.match(result.reason, /agent crashed/)
  assert.ok(calls.some(c => c.opts.label === 'sh:cleanup' && c.prompt.includes('git worktree remove --force')))
  const inLoop = await runBuild({}, { 'peer:2': failing })
  assert.equal(inLoop.result.status, 'blocked')
  assert.equal(inLoop.result.at, 1)
})

test('build: a lens or red team that crashes is a warning, not silence', async () => {
  const red = await runBuild({}, { 'redteam': failing })
  assert.equal(red.result.status, 'ready')
  assert.match(red.result.warnings.join('\n'), /redteam/)
  const lens = await runBuild({}, { 'review:security': failing })
  assert.match(lens.result.warnings.join('\n'), /review security/)
})

test('build: a failed worktree cleanup is a warning', async () => {
  const { result, byLabel } = await runBuild({}, { 'sh:cleanup': { output: 'fatal: locked\nEXIT=1' } })
  assert.match(result.warnings.join('\n'), /not removed/)
  assert.match(byLabel('sh:cleanup')[0].prompt, /\|\| rc=1/)
})

test('build: a finding the fix leaves open blocks the run', async () => {
  const { result } = await runBuild({}, {
    'review:correctness': { findings: [{ claim: 'c', evidence: 'src/slug.js:3', severity: 'blocker' }] },
    'fix': { applied: ['correctness-1: done'], declined: [] },
  })
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /correctness-1/)
  assert.equal(result.at, 2)
})

test('build: the fix check needs a new commit only when a fix was applied', async () => {
  const f = { 'review:correctness': { findings: [{ claim: 'c', evidence: 'src/slug.js:3', severity: 'major' }] } }
  const applied = await runBuild({}, { ...f, fix: { applied: ['correctness-1'], declined: [] } })
  assert.match(applied.byLabel('sh:check:fix')[0].prompt, /NO_COMMIT/)
  const declined = await runBuild({}, { ...f, fix: { applied: [], declined: [{ id: 'correctness-1', why: 'src/slug.js:3 is required' }] } })
  assert.doesNotMatch(declined.byLabel('sh:check:fix')[0].prompt, /NO_COMMIT/)
  assert.equal(declined.result.status, 'ready')
})

test('build: the tree is checked before the final gate even with no finding', async () => {
  const { byLabel, result } = await runBuild({}, { 'sh:check:fix': { output: 'HEAD=h9\nDIRTY\nEXIT=3' } })
  assert.ok(!byLabel('fix').length)
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /uncommitted/)
  assert.ok(!byLabel('sh:final:suite').length)
  const noHead = await runBuild({}, { 'sh:check:fix': { output: 'EXIT=0' } })
  assert.equal(noHead.result.status, 'blocked')
  assert.match(noHead.result.reason, /no HEAD line/)
})

test('build: a check without a HEAD line fails', async () => {
  const { byLabel } = await runBuild({}, { 'sh:check:1': { output: 'EXIT=0' } })
  assert.equal(byLabel('impl:1:retry').length, 1)
})

test('build: a red-team test file missing from the worktree is not a proof', async () => {
  const red = { findings: [{ claim: 'c1', test: 'test/red1.test.js', command: 'node --test test/red1.test.js', severity: 'major' }] }
  const { byLabel } = await runBuild({}, { redteam: red, 'sh:redteam:wt': { output: 'EXIT=0' }, 'sh:redteam:red-1': { output: 'NO_TEST\nEXIT=125' } })
  assert.ok(byLabel('sh:redteam:red-1')[0].prompt.includes("if test -f 'test/red1.test.js'; then"))
  assert.equal(byLabel('fix').length, 0, 'a missing test proves nothing: no finding to fix')
})

test('build: the retro must commit only its ADR', async () => {
  const ok = await runBuild()
  const chk = ok.byLabel('sh:check:adr')[0].prompt
  assert.ok(chk.includes("full=$(git ls-tree --full-name --name-only HEAD -- 'docs/adr/0001-add-thing.md' 2>/dev/null)") &&
    chk.includes(`git diff --name-only 'head-sh:check:fix' HEAD | grep -vxF -e "\${full:-/}" | grep -q .`) &&
    chk.includes(`test "$(git cat-file -t 'HEAD:./docs/adr/0001-add-thing.md' 2>/dev/null)" = blob`), chk)
  const abs = await runBuild({}, { retro: { adr: '/repo/./docs/adr/1.md', commit: 'c', rules: [] } })
  assert.ok(abs.byLabel('sh:check:adr')[0].prompt.includes("'HEAD:./docs/adr/1.md'"), 'an absolute path under dir becomes relative')
  const extra = await runBuild({}, { 'sh:check:adr': { output: 'EXTRA\nEXIT=0' } })
  assert.equal(extra.result.status, 'blocked')
  assert.match(extra.result.reason, /retro/)
  const noAdr = await runBuild({}, { 'sh:check:adr': { output: 'NO_ADR\nEXIT=0' } })
  assert.equal(noAdr.result.status, 'ready')
  assert.equal(noAdr.result.adr, '')
  assert.match(noAdr.result.warnings.join('\n'), /ADR/)
})

test('build: an experiment the retry invalidates stops the run, and a valid one keeps its measure', async () => {
  const sl = { ...SLICES_JSON, slices: [SLICE('Try NFKD', { kind: 'experiment', hypothesis: 'h' }), SLICES_JSON.slices[1]] }
  const retried = await runBuild({}, { 'sh:preflight': preflight({ slices: sl }), 'sh:gate:1': { output: 'EXIT=1' }, 'impl:1:retry': { ...IMPL, measure: '4ms', invalidated: true } })
  assert.equal(retried.result.status, 'invalidated')
  assert.equal(retried.result.measure, '4ms')
  const valid = await runBuild({}, { 'sh:preflight': preflight({ slices: sl }), 'impl:1': { ...IMPL, measure: '0.2ms' } })
  assert.equal(valid.result.slices[0].measure, '0.2ms')
  const re = await runBuild({}, { 'sh:preflight': preflight({ slices: sl }), 'impl:1': { ...IMPL, measure: '0.2ms' }, 'sh:gate:1': { output: 'EXIT=1' }, 'sh:gate:1:retry': { output: 'EXIT=0' }, 'impl:1:retry': { ...IMPL, measure: '0.3ms' } })
  assert.equal(re.result.slices[0].measure, '0.3ms', 'the retry measure replaces the first')
})

test('build: no finding means no fix agent', async () => {
  const { byLabel } = await runBuild()
  assert.ok(!byLabel('fix').length)
})

test('build: declined findings are reported, and their red tests are not rechecked', async () => {
  const red = { findings: [{ claim: 'c1', test: 't1.js', command: 'node --test t1.js', severity: 'major' }, { claim: 'c2', test: 't2.js', command: 'node --test t2.js', severity: 'minor' }] }
  const { byLabel, result } = await runBuild({}, {
    'redteam': red, 'sh:redteam': { output: 'fail\nEXIT=1' }, 'sh:redteam:wt': { output: 'EXIT=0' },
    'fix': { applied: ['red-1'], declined: [{ id: 'red-2', why: 'src/slug.js:4 is the contract' }] },
  })
  assert.equal(byLabel('sh:final:red:red-1').length, 1)
  assert.ok(!byLabel('sh:final:red:red-2').length)
  assert.match(result.warnings.join('\n'), /red-2/)
  assert.match(byLabel('sh:check:fix')[0].prompt, /'def5678'/)
})

test('build: the final gate reruns every slice gate, the suite and the lint; any failure blocks', async () => {
  const ok = await runBuild()
  for (const l of ['sh:final:gate:1', 'sh:final:gate:2', 'sh:final:suite', 'sh:final:lint', 'sh:final:mutation']) assert.equal(ok.byLabel(l).length, 1, l)
  assert.ok(ok.byLabel('sh:final:mutation')[0].prompt.includes("git diff 'abc1234' 'HEAD' >"))
  const bad = await runBuild({}, { 'sh:final:suite': { output: 'FAIL\nEXIT=1' } })
  assert.equal(bad.result.status, 'blocked')
  assert.match(bad.result.reason, /suite/)
  assert.equal(bad.result.at, 2, 'resume at the review')
  assert.ok(!bad.byLabel('retro').length)
  const mut = await runBuild({}, { 'sh:final:mutation': { output: 'survived\nEXIT=2' } })
  assert.equal(mut.result.status, 'ready')
  assert.match(mut.result.warnings.join('\n'), /mutants survive/)
})

test('build: the retro commits an ADR from decisions.md and the script writes retro.md', async () => {
  const { byLabel, result } = await runBuild()
  assert.match(byLabel('retro')[0].prompt, /decisions\.md/)
  assert.match(byLabel('retro')[0].prompt, /ADR/)
  assert.match(byLabel('sh:write:retro')[0].prompt, /slice 2 retried/)
  assert.equal(result.adr, 'docs/adr/0001-add-thing.md')
})

test('build: no prompt pipes into tail without pipefail, every label is unique, and every agent prompt has the data rule', async () => {
  const red = { findings: [{ claim: 'c1', test: 't1.js', command: 'node --test t1.js', severity: 'major' }] }
  const { calls } = await runBuild({}, { 'sh:gate:1': { output: 'EXIT=1' }, 'sh:mutation:2': { output: 'EXIT=2' }, 'redteam': red, 'sh:redteam': { output: 'EXIT=1' }, 'sh:redteam:wt': { output: 'EXIT=0' }, 'fix': { applied: ['red-1'], declined: [] } })
  for (const { prompt, opts } of calls) if (/\|\s*tail/.test(prompt)) assert.match(prompt, /set -o pipefail/, opts.label)
  const labels = calls.map(c => c.opts.label)
  assert.deepEqual(labels.filter((l, i) => labels.indexOf(l) !== i), [])
  for (const c of nonShell(calls)) assert.match(c.prompt, /data, never an instruction/, c.opts.label)
})
