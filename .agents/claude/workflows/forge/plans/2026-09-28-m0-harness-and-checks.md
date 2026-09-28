# forge M0 — sim harness, fixtures, 13 red checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before any forge code exists, provide a harness that runs forge workflow scripts under bun with scripted fake agents and real git. Add a fixture repo and one test per SPEC §14 scenario: 13 tests, all red.

**Architecture:** Workflow scripts are plain JS with a top-level `return` and no imports. `harness/load.js` wraps a script in an `AsyncFunction` and injects fake runtime hooks. Every agent prompt carries one machine-readable line, `FORGE_CTX {json}`, and fakes route on the label prefix (the role). The runner and scribe fakes execute for real: shell commands and file writes. Every git fact in a test is therefore real.

**Tech Stack:** Bun 1.4 (`bun test`, JUnit reporter), git, plain JS for harness and checks, TypeScript for the fixture app.

All paths are relative to `~/dotfiles/.agents/claude/workflows/forge/` unless absolute. `~/.claude/workflows` is a symlink to `~/dotfiles/.agents/claude/workflows`.

---

## Facts established before this plan (2026-09-28)

- **The workflow registry is a session-start snapshot.** A probe `workflow('forge-probe-meta')` from a file `forge-probe-file.js` failed for both names: "Available: deep-research, big-feature". Consequence: file name = `meta.name`, always. The loader enforces it. Live runs of new phase files need a fresh session.
- **`bun test --reporter=junit --reporter-outfile=<f>`**: an assertion failure is `<failure type="AssertionError">`, and a thrown stub is `<failure type="Error">`. A file that fails to import does not appear in the XML at all. "Not collected" is therefore detectable as a test that is absent from the XML.
- User decisions: sim + live tiers; `src/` + build step (M1); Bun + TS fixture; branch `feat/forge`, forge commits only.

## Harness contract (binding on M1+)

The forge implementation must satisfy this, or the checks cannot observe it.

- **Labels:** every `agent()` label starts with its role and a colon: `runner`, `scribe`, `scout`, `researcher`, `seat`, `planner`, `shadow`, `comparator`, `critic`, `builder`, `judge`, `red`, `blue`, `reviewer`. The runner re-verify after a stale resume uses the label prefix `runner:reverify`.
- **Prompts:** each prompt contains exactly one line `FORGE_CTX <json>`. Role fields:

| Role | ctx fields | returns |
|---|---|---|
| runner | `commands: [{cmd, cwd, tail?}]` | `{results: [{cmd, exit, tail}]}` |
| scribe | `writes: [{path, content}]`, `reads: [path]` | `{files: [{path, sha256, bytes, content?, missing?}]}` |
| scout | `task, dir` | `{files, helpers, conventions, signals: [{id, where}], commands: {install, test, fast, typecheck, lint}}` |
| planner | `task, scout, feedback?` | `{slices: [...§8 schema], rejected: []}` |
| shadow | `task, scout, signals` | `{clauses: [{id, kind, input, action, expected, signal}]}` |
| comparator | `plan, shadow` | `{pairs: [{planner_clause, shadow_clause, verdict}]}` |
| critic | `clauses` | `{verdicts: [{clause, verdict}]}` |
| builder | `stage: 'A'\|'B', worktree, slice, retry?: [{clause, test, verdict}]` | A: `{tests: [{clause, file, name, lines: [from, to]}]}` · B: `{done: true}` |
| judge | `items: [{ref, clause: {id, kind, input, action, expected}, test, source}]` | `{verdicts: [{ref, verdict}]}` — bound by `ref`, never by test name (M1 review) |
| red | `worktree, slice, round, attacker` | `{bugs: [{id, clause, variants: [{file, name}, {file, name}]}]}` |
| blue | `worktree, bugs: [{id, clause, file, name}]` — variant 1 only | `{results: [{bug, outcome: 'fixed'\|'reject', clause}]}` |
| seat, reviewer | free | `{concerns: []}`, `{findings: []}` |

- **Run dir:** `<dir>/.claude/runs/<runId>/` with `run.json` (`{runId, phase, status, tier, risk, signals, lastSha, worktree, planHash?}`), `plan.json`, `slices/<id>.json`, and `ledger.md`.
- **Slice record:** `{id, status: 'done'|'blocked'|'failed'|'escalated', reason?, commits: {A, B?, R?, F?}, judge: [{test, clause, verdict, attempt}], atA: [{test, clause, kind, outcome: 'fail'|'pass'|'not-collected'}], atB: [{test, clause, outcome}], protectedTouched: [], duel: {rounds: [{round, bugs: [{id, clause, verdict, status}]}]}}`. Bug `status` is one of `fixed | discarded | overreach | rejected | unfixed | held-out-failed | tamper | unchecked | dropped`.
- **Result:** `{status: 'done'|'checkpoint'|'refused'|'escalated'|'blocked'|'error', runId, runDir, reason?, planHash?, questions?: [{id, text}], underspecified?}`. A slice `failed` after its attempts yields result `escalated`.
- **Runner shell:** the fake runs `zsh -c`, like the Bash tool here. Commands must not rely on bash-only syntax (`PIPESTATUS`).
- **Branch:** `forge/<runId>/main`. Commit subjects are `<slice> tests` and `<slice> impl`. Ledger SHAs are 7 characters.
- **The user's checkout stays clean:** `git status --porcelain` in `<dir>` is empty after a run. `.claude/` is excluded via `.git/info/exclude`.

## File map

| File | Responsibility |
|---|---|
| `package.json` | `bun test` entry points, scoped to `./harness` and `./check` |
| `harness/repo.js` | `makeRepo(app)`: copy a fixture app into a temp dir, then `git init` and commit `base` |
| `harness/load.js` | compile a workflow script and run it with a fake runtime |
| `harness/fakes.js` | `readCtx`, `sha256`, runner, scribes, `simAgents(sim, overrides)` |
| `harness/run.js` | `runForge({sim, repo, args, overrides})`, plus artifact accessors |
| `harness/harness.test.js` | self-tests for load, fakes, and repo (green in M0) |
| `harness/fixtures.test.js` | proves the fixture data behaves as the scenarios assume (green in M0) |
| `fixtures/app/` | base repo: `src/text.ts` (capitalize), `src/export.ts` (open export) |
| `fixtures/sim/slugify/` | low-risk S task: scripted agent outputs and file variants |
| `fixtures/sim/export/` | high-risk auth task: plan vs shadow ambiguity (403 vs 404) |
| `check/scenarios.test.js` | the 13 SPEC §14 scenarios (red in M0) |

---

### Task 0: Commit the prior work in two logical commits

**Files:** `~/dotfiles/.agents/claude/agents/{advisor,architect,researcher,reviewer,implementer}.md`, `rules/verification.md`, `workflows/big-feature.js`, `workflows/forge/SPEC.md`

Do not stage `CLAUDE.md`, `slop-auditor.md`, `evals/`, `hooks/`, `settings.json`, `rules/{coding,context7,memory}.md`. Those are pre-existing and not part of this work.

- [ ] **Step 1: Stage the Fable→Opus move.** `reviewer.md` also has a test-rule hunk. Stage only its frontmatter hunk:

```bash
cd ~/dotfiles/.agents/claude
git diff -U0 agents/reviewer.md | awk '/^@@ -5,1/{p=1} /^@@ -3[0-9]/{p=0} p||/^(diff|index|---|\+\+\+)/' > /tmp/reviewer-model.patch
git apply --cached --unidiff-zero /tmp/reviewer-model.patch
git add agents/advisor.md agents/architect.md agents/researcher.md workflows/big-feature.js
git diff --cached --stat
```

Expected: 5 files. `reviewer.md` shows 1 insertion and 1 deletion. If the awk filter misses the hunk, use `git add -p agents/reviewer.md` and accept only the `model:` hunk.

- [ ] **Step 2: Commit.**

```bash
git commit -m "Move agents from Fable to Opus; make Fable an explicit big-feature escalation" -m "Opus 5.5 matches Fable on most tasks at 2.5x less per token. big-feature keeps Fable behind fable:true for novel or large multi-agent work."
```

- [ ] **Step 3: Commit the test rules.**

```bash
git add agents/implementer.md agents/reviewer.md rules/verification.md
git commit -m "Require every test to fail against a named plausible bug" -m "Tests that restate the implementation pass on bugs and break on refactors."
```

- [ ] **Step 4: Commit the spec and this plan.**

```bash
git add workflows/forge/SPEC.md workflows/forge/plans/
git commit -m "Add forge design spec and M0 plan"
git status --short workflows/ agents/ rules/verification.md
```

Expected: no line for `workflows/`, `agents/implementer.md`, `advisor`, `architect`, `researcher`, `reviewer`, or `verification.md`.

---

### Task 1: Package entry and fixture app with a green baseline

**Files:**
- Create: `package.json`, `harness/repo.js`, `harness/harness.test.js`
- Create: `fixtures/app/package.json`, `fixtures/app/tsconfig.json`, `fixtures/app/src/text.ts`, `fixtures/app/src/text.test.ts`, `fixtures/app/src/export.ts`, `fixtures/app/src/export.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "forge",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test ./harness ./check",
    "test:harness": "bun test ./harness",
    "test:check": "bun test ./check"
  }
}
```

- [ ] **Step 2: Write the failing test** in `harness/harness.test.js`

```js
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
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun test ./harness`
Expected: FAIL, `Cannot find module './repo.js'`.

- [ ] **Step 4: Write `harness/repo.js`**

```js
import { cpSync, mkdtempSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FIXTURES = join(import.meta.dir, '..', 'fixtures')

export const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim()

export function makeRepo(app = 'app') {
  const repo = mkdtempSync(join(tmpdir(), 'forge-sim-'))
  cpSync(join(FIXTURES, app), repo, { recursive: true })
  execSync(
    'git init -q -b main && git config user.email sim@forge.test && git config user.name forge-sim' +
      ' && git add -A && git commit -q -m base',
    { cwd: repo },
  )
  return repo
}
```

- [ ] **Step 5: Write the fixture app**

`fixtures/app/package.json`:

```json
{ "name": "forge-fixture", "private": true, "type": "module", "scripts": { "test": "bun test" } }
```

`fixtures/app/tsconfig.json`:

```json
{ "compilerOptions": { "strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "noEmit": true } }
```

`fixtures/app/src/text.ts`:

```ts
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
```

`fixtures/app/src/text.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { capitalize } from './text'

test('capitalize uppercases the first letter', () => {
  expect(capitalize('rust')).toBe('Rust')
})
```

`fixtures/app/src/export.ts`:

```ts
export type User = { id: string; role: 'admin' | 'member' }

export function exportReport(user: User): { status: number; body?: string } {
  return { status: 200, body: 'id,total\n1,100\n' }
}
```

`fixtures/app/src/export.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { exportReport } from './export'

test('admin receives the CSV report', () => {
  expect(exportReport({ id: 'u1', role: 'admin' })).toEqual({ status: 200, body: 'id,total\n1,100\n' })
})
```

- [ ] **Step 6: Run and confirm it passes**

Run: `bun test ./harness`
Expected: 2 pass. Also run `bun test ./harness 2>&1 | grep -c fixtures/app`. Expected: `0`, which proves the path filter does not collect the fixture's own tests. If it prints more than 0, bun treats the argument as a substring filter. In that case, rename the fixture test files to `*.fixture-test.ts` and add `fixtures/app/bunfig.toml` with `[test]\nroot = "src"`. Record the change in this plan.

- [ ] **Step 7: Commit**

```bash
git add workflows/forge/package.json workflows/forge/harness workflows/forge/fixtures/app
git commit -m "forge: add fixture app and repo sandbox for the sim harness"
```

---

### Task 2: Workflow loader with a faithful fake runtime

**Files:**
- Create: `harness/load.js`
- Modify: `harness/harness.test.js` (append a `describe('load')` block)

- [ ] **Step 1: Write the failing tests** (append to `harness/harness.test.js`)

```js
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadNamed, runWorkflow } from './load.js'

function workflowsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wf-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, `${name}.js`), body)
  return dir
}
const noAgent = async () => { throw new Error('no agent expected') }

describe('load', () => {
  test('runs a script with meta, args and a top-level return', async () => {
    const dir = workflowsDir({ toy: "export const meta = { name: 'toy', description: 't' }\nreturn { got: args.x, name: meta.name }" })
    expect(await runWorkflow('toy', { x: 1 }, noAgent, { dir })).toEqual({ got: 1, name: 'toy' })
  })

  test('refuses a missing script and a meta.name that differs from the file name', () => {
    const dir = workflowsDir({ odd: "export const meta = { name: 'other', description: 't' }\nreturn 1" })
    expect(() => loadNamed('absent', dir)).toThrow('workflow not built')
    expect(() => loadNamed('odd', dir)).toThrow('meta.name must equal the file name')
  })

  test('Date.now, argless new Date and Math.random throw; Math.max still works', async () => {
    const dir = workflowsDir({
      now: "export const meta = { name: 'now', description: 't' }\nreturn Date.now()",
      fresh: "export const meta = { name: 'fresh', description: 't' }\nreturn new Date()",
      rnd: "export const meta = { name: 'rnd', description: 't' }\nreturn Math.random()",
      max: "export const meta = { name: 'max', description: 't' }\nreturn Math.max(1, 2)",
    })
    await expect(runWorkflow('now', {}, noAgent, { dir })).rejects.toThrow('unavailable')
    await expect(runWorkflow('fresh', {}, noAgent, { dir })).rejects.toThrow('unavailable')
    await expect(runWorkflow('rnd', {}, noAgent, { dir })).rejects.toThrow('unavailable')
    expect(await runWorkflow('max', {}, noAgent, { dir })).toBe(2)
  })

  test('parallel and pipeline turn a throwing item into null', async () => {
    const dir = workflowsDir({
      p: "export const meta = { name: 'p', description: 't' }\n" +
        "const a = await parallel([() => 1, () => { throw new Error('x') }])\n" +
        "const b = await pipeline([1, 2], v => { if (v === 2) throw new Error('y'); return v * 10 }, v => v + 1)\n" +
        'return { a, b }',
    })
    expect(await runWorkflow('p', {}, noAgent, { dir })).toEqual({ a: [1, null], b: [11, null] })
  })

  test('workflow() nests one level: a child calling workflow() throws', async () => {
    const dir = workflowsDir({
      parent: "export const meta = { name: 'parent', description: 't' }\nreturn await workflow('child', { v: 2 })",
      child: "export const meta = { name: 'child', description: 't' }\nreturn args.v",
      deep: "export const meta = { name: 'deep', description: 't' }\nreturn await workflow('parent2')",
      parent2: "export const meta = { name: 'parent2', description: 't' }\nreturn await workflow('child')",
    })
    expect(await runWorkflow('parent', {}, noAgent, { dir })).toBe(2)
    await expect(runWorkflow('deep', {}, noAgent, { dir })).rejects.toThrow('nests one level')
  })

  test('log() messages reach onLog', async () => {
    const dir = workflowsDir({ l: "export const meta = { name: 'l', description: 't' }\nlog('hi')\nreturn 0" })
    const logs = []
    await runWorkflow('l', {}, noAgent, { dir, onLog: m => logs.push(m) })
    expect(logs).toEqual(['hi'])
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test ./harness`
Expected: FAIL, `Cannot find module './load.js'`.

- [ ] **Step 3: Write `harness/load.js`**

```js
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Built phase scripts live flat beside forge/, where the Workflow registry reads them.
export const WORKFLOWS_DIR = join(import.meta.dir, '..', '..')

const AsyncFunction = (async () => {}).constructor
const HOOKS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'Date', 'Math']

const unavailable = what => () => { throw new Error(`${what} is unavailable in workflow scripts`) }

// The real runtime rejects these because they break resume; a script that uses them
// must fail here too, or the sim passes code the real runtime refuses.
const GuardedDate = new Proxy(Date, {
  apply: unavailable('Date()'),
  construct(target, argv) {
    if (!argv.length) unavailable('new Date()')()
    return new target(...argv)
  },
  get: (target, key) => (key === 'now' ? unavailable('Date.now()') : target[key]),
})
const GuardedMath = new Proxy(Math, {
  get: (target, key) => (key === 'random' ? unavailable('Math.random()') : target[key]),
})

export function loadNamed(name, dir = WORKFLOWS_DIR) {
  const path = join(dir, `${name}.js`)
  if (!existsSync(path)) throw new Error(`workflow not built: ${path}`)
  const source = readFileSync(path, 'utf8')
  // The registry snapshot showed names must be unambiguous; forge pins file = meta.name.
  const declared = source.match(/^export const meta\s*=\s*\{[^}]*?\bname:\s*'([^']+)'/m)
  if (!declared || declared[1] !== name) throw new Error(`${path}: meta.name must equal the file name "${name}"`)
  return new AsyncFunction(...HOOKS, source.replace(/^export const meta\s*=/m, 'const meta ='))
}

export async function runWorkflow(name, args, agent, { dir = WORKFLOWS_DIR, onLog = () => {}, depth = 0 } = {}) {
  const fn = loadNamed(name, dir)
  const parallel = thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let value = item
        for (const stage of stages) value = await stage(value, item, i)
        return value
      } catch {
        return null
      }
    }))
  const workflow = async (child, childArgs) => {
    if (depth > 0) throw new Error('workflow() nests one level only')
    return runWorkflow(child, childArgs, agent, { dir, onLog, depth: depth + 1 })
  }
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  return fn(agent, parallel, pipeline, () => {}, onLog, args, budget, workflow, GuardedDate, GuardedMath)
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test ./harness`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add workflows/forge/harness
git commit -m "forge: add sim loader that runs workflow scripts under a guarded fake runtime"
```

---

### Task 3: Fake agents — real runner, honest and lying scribes, role routing

**Files:**
- Create: `harness/fakes.js`
- Modify: `harness/harness.test.js` (append a `describe('fakes')` block)

- [ ] **Step 1: Write the failing tests**

```js
import { existsSync, mkdtempSync as mkd, readFileSync } from 'node:fs'
import { readCtx, sha256, runCommands, honestScribe, lyingScribe, simAgents } from './fakes.js'

const ctxPrompt = ctx => `Do the thing.\nFORGE_CTX ${JSON.stringify(ctx)}\nThanks.`

describe('fakes', () => {
  test('readCtx parses the FORGE_CTX line and rejects a prompt without one', () => {
    expect(readCtx(ctxPrompt({ a: 1 }))).toEqual({ a: 1 })
    expect(() => readCtx('no context here')).toThrow('FORGE_CTX')
  })

  test('runner executes each command in its cwd and returns exit and tail', () => {
    const cwd = mkd(join(tmpdir(), 'forge-run-'))
    const r = runCommands([{ cmd: 'pwd', cwd }, { cmd: 'echo boom >&2; exit 3', cwd }])
    expect(r.results[0]).toMatchObject({ exit: 0 })
    expect(r.results[0].tail).toContain('forge-run-')
    expect(r.results[1]).toMatchObject({ exit: 3, tail: 'boom\n' })
  })

  test('runner honors a per-command tail length', () => {
    const r = runCommands([{ cmd: 'printf abcdef', cwd: tmpdir(), tail: 3 }])
    expect(r.results[0].tail).toBe('def')
  })

  test('honest scribe writes, then hashes what is on disk', () => {
    const path = join(mkd(join(tmpdir(), 'forge-scribe-')), 'a', 'b.json')
    const r = honestScribe({ writes: [{ path, content: '{"x":1}' }] })
    expect(readFileSync(path, 'utf8')).toBe('{"x":1}')
    expect(r.files[0]).toEqual({ path, sha256: sha256('{"x":1}'), bytes: 7 })
  })

  test('honest scribe reads back content with its hash, and flags a missing file', () => {
    const dir = mkd(join(tmpdir(), 'forge-scribe-'))
    honestScribe({ writes: [{ path: join(dir, 'r.json'), content: 'hi' }] })
    const r = honestScribe({ reads: [join(dir, 'r.json'), join(dir, 'nope')] })
    expect(r.files[0]).toMatchObject({ content: 'hi', sha256: sha256('hi') })
    expect(r.files[1]).toMatchObject({ missing: true })
  })

  test('lying scribe writes nothing and returns a hash that is not the content hash', () => {
    const path = join(mkd(join(tmpdir(), 'forge-scribe-')), 'c.json')
    const r = lyingScribe({ writes: [{ path, content: 'x' }] })
    expect(existsSync(path)).toBe(false)
    expect(r.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.files[0].sha256).not.toBe(sha256('x'))
  })

  test('simAgents routes on the label prefix, records calls, and rejects an unknown role', async () => {
    const { agent, calls } = simAgents('slugify', { planner: ctx => ({ echoed: ctx.task }) })
    expect(await agent(ctxPrompt({ task: 't' }), { label: 'planner:main' })).toEqual({ echoed: 't' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ role: 'planner', label: 'planner:main', ctx: { task: 't' } })
    await expect(agent(ctxPrompt({}), { label: 'wizard:1' })).rejects.toThrow('no fake for role "wizard"')
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test ./harness`
Expected: FAIL, `Cannot find module './fakes.js'`.

- [ ] **Step 3: Write `harness/fakes.js`**

```js
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SIM_DIR = join(import.meta.dir, '..', 'fixtures', 'sim')
const DEFAULT_TAIL = 4000

export const sha256 = data => createHash('sha256').update(data).digest('hex')

export function readCtx(prompt) {
  const line = String(prompt).split('\n').find(l => l.startsWith('FORGE_CTX '))
  if (!line) throw new Error('prompt has no FORGE_CTX line')
  return JSON.parse(line.slice('FORGE_CTX '.length))
}

// The runner is the only role whose fake does real work in every scenario: every
// SHA and exit code a check asserts on comes from here, as it will in a live run.
export function runCommands(commands) {
  return {
    results: commands.map(({ cmd, cwd, tail = DEFAULT_TAIL }) => {
      const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' })
      return { cmd, exit: r.status ?? -1, tail: ((r.stdout || '') + (r.stderr || '')).slice(-tail) }
    }),
  }
}

export function honestScribe({ writes = [], reads = [] }) {
  const files = []
  for (const { path, content } of writes) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    const disk = readFileSync(path)
    files.push({ path, sha256: sha256(disk), bytes: disk.length })
  }
  for (const path of reads) {
    if (!existsSync(path)) { files.push({ path, missing: true }); continue }
    const content = readFileSync(path, 'utf8')
    files.push({ path, content, sha256: sha256(content), bytes: Buffer.byteLength(content) })
  }
  return { files }
}

// A model that skips the write cannot compute a sha256 in its head; it returns
// something hash-shaped instead. SPEC §14 scenario 10.
export function lyingScribe({ writes = [] }) {
  return { files: writes.map(({ path, content }) => ({ path, sha256: sha256(`not written: ${path}`), bytes: Buffer.byteLength(content) })) }
}

export function simAgents(simName, overrides = {}) {
  const sim = join(SIM_DIR, simName)
  const json = file => JSON.parse(readFileSync(join(sim, file), 'utf8'))
  const copyInto = (variant, worktree) => cpSync(join(sim, variant), worktree, { recursive: true })
  const defaults = {
    runner: ctx => runCommands(ctx.commands),
    scribe: honestScribe,
    scout: () => json('scout.json'),
    seat: () => ({ concerns: [] }),
    planner: () => json('plan.json'),
    shadow: () => json('shadow.json'),
    comparator: () => json('compare.json'),
    critic: ctx => ({ verdicts: ctx.clauses.map(c => ({ clause: c.id, verdict: 'ok' })) }),
    builder: ctx => {
      copyInto(ctx.stage, ctx.worktree)
      return ctx.stage === 'A' ? json('builder-A.json') : { done: true }
    },
    judge: ctx => ({ verdicts: ctx.items.map(i => ({ test: i.test, verdict: 'valid' })) }),
    red: () => ({ bugs: [] }),
    blue: ctx => ({ results: ctx.bugs.map(b => ({ bug: b.id, outcome: 'reject', clause: b.clause })) }),
    reviewer: () => ({ findings: [] }),
  }
  const roles = { ...defaults, ...overrides }
  const calls = []
  const agent = async (prompt, opts = {}) => {
    const role = String(opts.label || '').split(':')[0]
    const ctx = readCtx(prompt)
    calls.push({ role, label: opts.label, ctx, opts })
    if (!roles[role]) throw new Error(`no fake for role "${role}" (label ${opts.label})`)
    return roles[role](ctx, { sim, json, copyInto, calls })
  }
  return { agent, calls }
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test ./harness`
Expected: 15 pass, 0 fail. The `simAgents` test does not read any sim file, so it passes before `fixtures/sim/slugify/` exists.

- [ ] **Step 5: Commit**

```bash
git add workflows/forge/harness
git commit -m "forge: add fake agents — real runner, honest and lying scribes, role routing"
```

---

### Task 4: slugify sim fixture (low-risk S task, planted bug, red and blue variants)

**Files:**
- Create: `harness/fixtures.test.js`
- Create under `fixtures/sim/slugify/`: `task.json`, `scout.json`, `plan.json`, `shadow.json`, `compare.json`, `builder-A.json`, `A/src/text.ts`, `A/src/text.test.ts`, `B/src/text.ts`, `B-buggy/src/text.ts`, `red-planted.json`, `red-planted/src/red/S1-b1-v1.test.ts`, `red-planted/src/red/S1-b1-v2.test.ts`, `red-restating.json`, `red-restating/src/red/S1-b1-v1.test.ts`, `red-restating/src/red/S1-b1-v2.test.ts`, `blue-fix.json`, `blue-fix/src/text.ts`, `blue-specialcase/src/text.ts`, `blue-tamper/src/red/S1-b1-v1.test.ts`

- [ ] **Step 1: Write the failing tests** in `harness/fixtures.test.js`

```js
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
    expect(Object.values(junit(repo)).every(v => v === 'pass')).toBe(true)
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
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test ./harness/fixtures.test.js`
Expected: FAIL, ENOENT on `fixtures/sim/slugify/...`.

- [ ] **Step 3: Write the slugify fixture files**

`fixtures/sim/slugify/task.json`:

```json
{ "app": "app", "task": "Add slugify(title) to src/text.ts: lowercase, runs of non-alphanumerics become one hyphen, no leading or trailing hyphen." }
```

`fixtures/sim/slugify/scout.json`:

```json
{
  "files": ["src/text.ts", "src/text.test.ts"],
  "helpers": [],
  "conventions": "named exports, bun:test, tests beside sources",
  "signals": [],
  "commands": { "test": "bun test", "fast": "bun test", "typecheck": null, "lint": null }
}
```

`fixtures/sim/slugify/plan.json`:

```json
{
  "slices": [{
    "id": "S1",
    "title": "slugify",
    "files": ["src/text.ts", "src/text.test.ts"],
    "spec": [
      { "id": "S1.1", "kind": "behavior", "input": "'Hello World'", "action": "slugify(input)", "expected": "'hello-world'", "source": "task" },
      { "id": "S1.2", "kind": "behavior", "input": "'C++ & Rust'", "action": "slugify(input)", "expected": "'c-rust': a run of non-alphanumerics becomes one hyphen", "source": "task" },
      { "id": "S1.3", "kind": "behavior", "input": "a title with leading or trailing separators, e.g. '  Hello  '", "action": "slugify(input)", "expected": "no leading or trailing hyphen: 'hello'", "source": "task" }
    ],
    "acceptance": [
      { "clause": "S1.1", "level": "unit" },
      { "clause": "S1.2", "level": "unit" },
      { "clause": "S1.3", "level": "unit" }
    ],
    "structure": "none",
    "depends_on": [],
    "notes": ""
  }],
  "rejected": []
}
```

`fixtures/sim/slugify/shadow.json`: `{ "clauses": [] }`

`fixtures/sim/slugify/compare.json`: `{ "pairs": [] }`

`fixtures/sim/slugify/builder-A.json`:

```json
{
  "tests": [
    { "clause": "S1.1", "file": "src/text.test.ts", "name": "S1.1 slugify lowercases and joins words with hyphens", "lines": [8, 10] },
    { "clause": "S1.2", "file": "src/text.test.ts", "name": "S1.2 slugify collapses runs of non-alphanumerics into one hyphen", "lines": [12, 14] },
    { "clause": "S1.3", "file": "src/text.test.ts", "name": "S1.3 slugify leaves no leading or trailing hyphen", "lines": [16, 18] }
  ]
}
```

`fixtures/sim/slugify/A/src/text.ts`:

```ts
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function slugify(title: string): string {
  throw new Error('not implemented')
}
```

`fixtures/sim/slugify/A/src/text.test.ts` (line numbers matter: the three `test(` lines are 8, 12, 16):

```ts
import { expect, test } from 'bun:test'
import { capitalize, slugify } from './text'

test('capitalize uppercases the first letter', () => {
  expect(capitalize('rust')).toBe('Rust')
})

test('S1.1 slugify lowercases and joins words with hyphens', () => {
  expect(slugify('Hello World')).toBe('hello-world')
})

test('S1.2 slugify collapses runs of non-alphanumerics into one hyphen', () => {
  expect(slugify('C++ & Rust')).toBe('c-rust')
})

test('S1.3 slugify leaves no leading or trailing hyphen', () => {
  expect(slugify('  Hello  ')).toBe('hello')
})
```

`fixtures/sim/slugify/B/src/text.ts` and `fixtures/sim/slugify/blue-fix/src/text.ts` (identical):

```ts
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
```

`fixtures/sim/slugify/B-buggy/src/text.ts`. The bug: `trim()` removes whitespace but not punctuation, so `'Hello!'` gives `'hello-'`. The builder tests still pass because S1.3 only tests whitespace.

```ts
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
```

`fixtures/sim/slugify/blue-specialcase/src/text.ts`:

```ts
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function slugify(title: string): string {
  if (title === 'Hello!') return 'hello'
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
```

`fixtures/sim/slugify/red-planted.json`:

```json
{
  "bugs": [{
    "id": "b1",
    "clause": "S1.3",
    "variants": [
      { "file": "src/red/S1-b1-v1.test.ts", "name": "b1 v1: trailing punctuation leaves no trailing hyphen" },
      { "file": "src/red/S1-b1-v2.test.ts", "name": "b1 v2: surrounding punctuation leaves no hyphen" }
    ]
  }]
}
```

`fixtures/sim/slugify/red-planted/src/red/S1-b1-v1.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v1: trailing punctuation leaves no trailing hyphen', () => {
  expect(slugify('Hello!')).toBe('hello')
})
```

`fixtures/sim/slugify/red-planted/src/red/S1-b1-v2.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v2: surrounding punctuation leaves no hyphen', () => {
  expect(slugify('?Rust?')).toBe('rust')
})
```

`fixtures/sim/slugify/blue-tamper/src/red/S1-b1-v1.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v1: trailing punctuation leaves no trailing hyphen', () => {
  expect(slugify('Hello!')).toBe('hello-')
})
```

`fixtures/sim/slugify/blue-fix.json`:

```json
{ "results": [{ "bug": "b1", "outcome": "fixed", "clause": "S1.3" }] }
```

`fixtures/sim/slugify/red-restating.json`:

```json
{
  "bugs": [{
    "id": "b1",
    "clause": "S1.1",
    "variants": [
      { "file": "src/red/S1-b1-v1.test.ts", "name": "b1 v1: words join with underscores" },
      { "file": "src/red/S1-b1-v2.test.ts", "name": "b1 v2: words join with underscores, again" }
    ]
  }]
}
```

`fixtures/sim/slugify/red-restating/src/red/S1-b1-v1.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v1: words join with underscores', () => {
  expect(slugify('Hello World')).toBe('hello_world')
})
```

`fixtures/sim/slugify/red-restating/src/red/S1-b1-v2.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { slugify } from '../text'

test('b1 v2: words join with underscores, again', () => {
  expect(slugify('Big Cat')).toBe('big_cat')
})
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test ./harness/fixtures.test.js`
Expected: 7 pass. If the JUnit regex misreads bun's passing-test shape, print `xml` once, fix the regex, and keep the test assertions unchanged.

- [ ] **Step 5: Commit**

```bash
git add workflows/forge/harness/fixtures.test.js workflows/forge/fixtures/sim/slugify
git commit -m "forge: add slugify sim fixture with planted bug and red/blue variants"
```

---

### Task 5: export sim fixture (high-risk auth, plan vs shadow ambiguity)

**Files:**
- Modify: `harness/fixtures.test.js` (append a `describe('export fixture')` block)
- Create under `fixtures/sim/export/`: `task.json`, `scout.json`, `plan.json`, `shadow.json`, `compare.json`, `builder-A.json`, `A/src/export.test.ts`, `B/src/export.ts`

- [ ] **Step 1: Write the failing tests** (append)

```js
describe('export fixture', () => {
  test('at A the negative clause fails and the preserve clause passes', () => {
    const repo = makeRepo('app'); apply(repo, 'export', 'A')
    const r = junit(repo)
    expect(r['S1.2 a member is refused with 403 and no body']).toBe('fail')
    expect(r['admin receives the CSV report']).toBe('pass')
  })

  test('at B every test passes', () => {
    const repo = makeRepo('app'); apply(repo, 'export', 'A', 'B')
    expect(Object.values(junit(repo)).every(v => v === 'pass')).toBe(true)
  })

  test('plan and shadow disagree on the member status, and compare pairs them as differs', () => {
    const read = f => JSON.parse(readFileSync(join(SIM_DIR, 'export', f), 'utf8'))
    const plan = read('plan.json'), shadow = read('shadow.json'), compare = read('compare.json')
    const s12 = plan.slices[0].spec.find(c => c.id === 'S1.2')
    const h1 = shadow.clauses.find(c => c.id === 'H1')
    expect(s12.expected).toContain('403')
    expect(h1.expected).toContain('404')
    expect(compare.pairs).toEqual([{ planner_clause: 'S1.2', shadow_clause: 'H1', verdict: 'differs' }])
    expect(read('scout.json').signals.map(s => s.id)).toContain('auth')
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test ./harness/fixtures.test.js`
Expected: 3 new failures, ENOENT on `fixtures/sim/export/...`.

- [ ] **Step 3: Write the export fixture files**

`fixtures/sim/export/task.json`:

```json
{ "app": "app", "task": "Only admins may export reports." }
```

`fixtures/sim/export/scout.json`:

```json
{
  "files": ["src/export.ts", "src/export.test.ts"],
  "helpers": [],
  "conventions": "named exports, bun:test, tests beside sources",
  "signals": [
    { "id": "auth", "where": "task" },
    { "id": "auth", "where": "src/export.ts:3" }
  ],
  "commands": { "test": "bun test", "fast": "bun test", "typecheck": null, "lint": null }
}
```

`fixtures/sim/export/plan.json`:

```json
{
  "slices": [{
    "id": "S1",
    "title": "restrict export to admins",
    "files": ["src/export.ts", "src/export.test.ts"],
    "spec": [
      { "id": "S1.1", "kind": "preserve", "input": "a user with role 'admin'", "action": "exportReport(user)", "expected": "status 200 with the CSV body", "source": "task" },
      { "id": "S1.2", "kind": "negative", "input": "a user with role 'member'", "action": "exportReport(user)", "expected": "status 403, no body", "source": "task" }
    ],
    "acceptance": [
      { "clause": "S1.1", "level": "unit" },
      { "clause": "S1.2", "level": "unit" }
    ],
    "structure": "none",
    "depends_on": [],
    "notes": ""
  }],
  "rejected": []
}
```

`fixtures/sim/export/shadow.json`:

```json
{ "clauses": [{ "id": "H1", "kind": "negative", "input": "a user with role 'member'", "action": "exportReport(user)", "expected": "status 404, no body", "signal": "auth" }] }
```

`fixtures/sim/export/compare.json`:

```json
{ "pairs": [{ "planner_clause": "S1.2", "shadow_clause": "H1", "verdict": "differs" }] }
```

`fixtures/sim/export/builder-A.json`:

```json
{
  "tests": [
    { "clause": "S1.1", "file": "src/export.test.ts", "name": "admin receives the CSV report", "lines": [4, 6] },
    { "clause": "S1.2", "file": "src/export.test.ts", "name": "S1.2 a member is refused with 403 and no body", "lines": [8, 10] }
  ]
}
```

`fixtures/sim/export/A/src/export.test.ts` (the `test(` lines are 4 and 8):

```ts
import { expect, test } from 'bun:test'
import { exportReport } from './export'

test('admin receives the CSV report', () => {
  expect(exportReport({ id: 'u1', role: 'admin' })).toEqual({ status: 200, body: 'id,total\n1,100\n' })
})

test('S1.2 a member is refused with 403 and no body', () => {
  expect(exportReport({ id: 'u2', role: 'member' })).toEqual({ status: 403 })
})
```

`fixtures/sim/export/B/src/export.ts`:

```ts
export type User = { id: string; role: 'admin' | 'member' }

export function exportReport(user: User): { status: number; body?: string } {
  if (user.role !== 'admin') return { status: 403 }
  return { status: 200, body: 'id,total\n1,100\n' }
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test ./harness`
Expected: all harness and fixture tests pass (25).

- [ ] **Step 5: Commit**

```bash
git add workflows/forge/harness/fixtures.test.js workflows/forge/fixtures/sim/export
git commit -m "forge: add export sim fixture with a 403-vs-404 planted ambiguity"
```

---

### Task 6: runForge and the 13 scenario checks — all red

**Files:**
- Create: `harness/run.js`, `check/scenarios.test.js`

- [ ] **Step 1: Write `harness/run.js`**

This is glue, not logic. It is exercised by the scenarios, which cannot pass until forge exists, so it gets no separate test. Its parts (`makeRepo`, `simAgents`, `runWorkflow`) are tested.

```js
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWorkflow } from './load.js'
import { SIM_DIR, simAgents } from './fakes.js'
import { git, makeRepo } from './repo.js'

export async function runForge({ sim, repo, args = {}, overrides = {} }) {
  const fixture = JSON.parse(readFileSync(join(SIM_DIR, sim, 'task.json'), 'utf8'))
  repo = repo || makeRepo(fixture.app)
  const { agent, calls } = simAgents(sim, overrides)
  const logs = []
  const fullArgs = { task: fixture.task, dir: repo, runId: 'sim', ...args }
  const result = await runWorkflow('forge', fullArgs, agent, { onLog: m => logs.push(m) })
  const runDir = join(repo, '.claude', 'runs', fullArgs.runId)
  return {
    result, calls, logs, repo, runDir,
    json: rel => JSON.parse(readFileSync(join(runDir, rel), 'utf8')),
    ledger: () => readFileSync(join(runDir, 'ledger.md'), 'utf8'),
    git: argv => git(repo, argv),
  }
}
```

- [ ] **Step 2: Write `check/scenarios.test.js`**

```js
import { expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runForge } from '../harness/run.js'
import { lyingScribe } from '../harness/fakes.js'

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
        test: i.test,
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
    judge: ctx => ({ verdicts: ctx.items.map(i => ({ test: i.test, verdict: i.test.startsWith('b1') ? 'wrong_oracle' : 'valid' })) }),
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
      writeFileSync(join(ctx.worktree, 'package.json'), '{ "name": "forge-fixture", "type": "module", "scripts": { "test": "bun test --bail=0 || true" } }\n')
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
```

- [ ] **Step 3: Run the checks and confirm all 13 are red for the right reason**

Run: `bun test ./check 2>&1 | tail -20`
Expected: `0 pass`, `13 fail`, and each failure message contains `workflow not built: .../workflows/forge.js`. Any other failure message is a bug in the check or the harness. Fix it before committing.

Run: `bun test ./harness`
Expected: all pass (25).

- [ ] **Step 4: Commit**

```bash
git add workflows/forge/harness/run.js workflows/forge/check
git commit -m "forge: add the 13 SPEC §14 scenario checks, red until forge exists"
```

---

### Task 7: Fold the new facts into the SPEC

**Files:** Modify `SPEC.md` §4 (last paragraph), §6 (baseline order), and §16.

- [ ] **Step 1: §4.** Replace "This folder holds docs and fixtures only." with:

```markdown
This folder holds docs, fixtures, the sim harness and the checks. Scripts cannot
import, so shared code lives in `forge/src/` and a build step concatenates it into
the flat `forge*.js` files. Every file name equals its `meta.name`. The registry is
a session-start snapshot, so a new phase file is visible only in a fresh session.
```

- [ ] **Step 2: §6.** After the **Baseline** paragraph, add:

```markdown
The scout reports the test, fast-suite, typecheck and lint commands; the runner
then runs them for the baseline. The runner executes script-composed commands
verbatim and never chooses a command itself.
```

- [ ] **Step 3: §16.** Move the `workflow('forge-duel')` bullet to "Resolved by review" and rewrite it:

```markdown
- `workflow(name)` could not be probed by name vs file: the registry is loaded at
  session start and ignored a file added mid-session. Forge pins file name =
  `meta.name`, which makes the question moot; the sim loader enforces it.
- bun JUnit: an assertion is `<failure type="AssertionError">`, a thrown stub is
  `type="Error"`, and a file that fails to import is absent from the XML. For bun,
  "not collected" = absent from the XML.
```

Add one open bullet:

```markdown
- Mutation testing for bun: StrykerJS has no confirmed bun test runner. Check before
  M3; until then a high-risk bun slice logs `mutation: skipped (no tool)`.
```

- [ ] **Step 4: Commit**

```bash
git add workflows/forge/SPEC.md
git commit -m "forge spec: record registry snapshot, bun JUnit semantics, scout-owned commands"
```

---

## After M0 (separate plans, written once M0 lands)

- **M1 — minimal path.** `src/` and `build.js` with a staleness check, `lib` (sha256, re-triage, plan checks, JUnit parse, ledger lines), then `forge`, `forge-triage`, `forge-plan`, `forge-build`, `forge-duel` (1 attacker, 1 round), and `forge-close`. Turns scenarios 1, 2, 10, 12 green, plus 9 once resume lands.
- **M2 — full duel.** Held-out variant, anti-tamper, protected files, concurrency rule, round 2. Scenarios 3–7.
- **M3 — high risk.** Shadow planner, comparator, question checkpoint, plan hash, required kinds, and council. Scenarios 8, 11, 13. Check StrykerJS for bun first.
- **M4 — live tier and swap.** Live evals: the judge on fixed pairs (2, 3), and real runs on both fixtures (7, 13). Check that codex `-s workspace-write` works in a runner-created worktree. Write `README.md` with the flow and weak points. Replace `big-feature.js`.
