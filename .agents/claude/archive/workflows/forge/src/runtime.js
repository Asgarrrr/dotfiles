// Helpers that spawn agents. They use the workflow runtime's `agent` global, so
// they are tested through the scenario checks, not in isolation.
import { sha256, byteLength, parseJunit, junitCommand, suiteCommand, parsePorcelain, isProtected, q } from './lib.js'

// ---------- stops ----------

export function stop(status, reason) {
  const e = new Error(`forge ${status}: ${reason}`)
  e.forge = { status, reason }
  throw e
}

// Phases return stops as data: an error's own fields may not survive workflow().
export async function guard(out, body) {
  try {
    return await body()
  } catch (e) {
    if (e && e.forge) return { ...out, stop: e.forge }
    throw e
  }
}

// ---------- prompt plumbing ----------

// The one machine-readable line every forge prompt carries (harness contract).
export const withCtx = (text, ctx) => `${text}\n\nFORGE_CTX ${JSON.stringify(ctx)}`

const str = { type: 'string' }
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })
const arr = items => ({ type: 'array', items })

// ---------- runner ----------

const RUNNER_PROMPT =
  'You are the forge runner. Execute every command in FORGE_CTX.commands with the Bash tool, ' +
  'in order, in its `cwd`, exactly as written. Never fix, retry, reorder, skip or add a command, ' +
  'even after a failure. For each command return its exit code and the last `tail` characters ' +
  '(default 4000) of combined stdout and stderr, verbatim. One result per command, in order.'
const RUNNER_SCHEMA = obj({ results: arr(obj({ cmd: str, exit: { type: 'integer' }, tail: str })) })

export async function run(label, commands) {
  const r = await agent(withCtx(RUNNER_PROMPT, { commands }), {
    label: `runner:${label}`, model: 'sonnet', effort: 'low', schema: RUNNER_SCHEMA,
  })
  const results = r && Array.isArray(r.results) ? r.results : []
  if (results.length !== commands.length) stop('error', `runner:${label} returned ${results.length}/${commands.length} results`)
  return results
}

export async function runOk(label, commands) {
  const results = await run(label, commands)
  const i = results.findIndex(x => x.exit !== 0)
  if (i >= 0) stop('error', `runner:${label}: \`${commands[i].cmd}\` exited ${results[i].exit}: ${String(results[i].tail).slice(-400)}`)
  return results
}

export function shaOf(tail) {
  const m = String(tail).match(/\b[0-9a-f]{40}\b/)
  if (!m) stop('error', `expected a commit sha, got: ${String(tail).slice(0, 80)}`)
  return m[0]
}

export async function commit(label, cwd, message, { amend = false } = {}) {
  const cmd = amend ? 'git add -A && git commit -q --allow-empty --amend --no-edit' : `git add -A && git commit -q --allow-empty -m ${q(message)}`
  const [, head] = await runOk(label, [{ cmd, cwd }, { cmd: 'git rev-parse HEAD', cwd }])
  return shaOf(head.tail)
}

// An agent told not to commit may commit anyway; a clean tree would then hide its
// edits from porcelain. HEAD must still be where the script left it.
export async function protectedChanges(label, cwd, expectedHead) {
  const [head, status] = await runOk(label, [
    { cmd: 'git rev-parse HEAD', cwd },
    { cmd: 'git status --porcelain=v1 -uall', cwd, tail: 100000 },
  ])
  const now = shaOf(head.tail)
  if (now !== expectedHead) stop('blocked', `${label}: the agent committed on its own (HEAD ${now.slice(0, 7)}, expected ${expectedHead.slice(0, 7)})`)
  const changed = parsePorcelain(status.tail)
  return { changed, touched: changed.filter(isProtected) }
}

// Files changed between two commits, limited to `files` — the tamper check.
export async function editedBetween(label, cwd, from, to, files) {
  if (!files.length) return []
  const [r] = await runOk(label, [{ cmd: `git diff --name-only ${from} ${to} -- ${files.map(q).join(' ')}`, cwd, tail: 100000 }])
  return r.tail.split('\n').filter(Boolean)
}

// Runs the suite with a JUnit report. Only the tags are returned — a small surface
// for the runner to transcribe.
export async function runTests(label, { cwd, testCmd, runDir }) {
  const out = `${runDir}/junit/${label}.xml`
  const jc = junitCommand(testCmd, out)
  if (!jc) stop('escalated', `no JUnit adapter yet for the test command "${testCmd}"`)
  const [clean, suite, report] = await run(`test:${label}`, [
    { cmd: 'test -z "$(git status --porcelain)"', cwd },
    { cmd: `mkdir -p ${q(`${runDir}/junit`)} && rm -f ${q(out)} && ${suiteCommand(jc, `${runDir}/junit/${label}.log`)}`, cwd, tail: 3000 },
    { cmd: `grep -oE '<testcase [^>]*>|</testcase>|<(failure|error) type="[^"]*"|<skipped' ${q(out)}`, cwd, tail: 400000 },
  ])
  if (clean.exit !== 0) stop('blocked', `tree not clean before the test run in ${cwd}`)
  return { exit: suite.exit, tail: suite.tail, cases: parseJunit(report.tail) }
}

// ---------- scribe ----------

const SCRIBE_PROMPT =
  'You are the forge scribe. For each entry in FORGE_CTX.writes, write `content` to `path` exactly, ' +
  'byte for byte, creating parent directories. Then run `shasum -a 256 <path>` and `wc -c < <path>` ' +
  'and report the hash and byte count from that output — never compute or copy them yourself.'
const SCRIBE_SCHEMA = obj({ files: arr(obj({ path: str, sha256: str, bytes: { type: 'integer' } })) })

export const serialize = v => (typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`)

// The hash is computed here and compared with the scribe's shasum: a scribe that
// skips or mangles a write cannot produce the right one.
export async function persist(label, writes) {
  const list = Object.entries(writes).map(([path, v]) => ({ path, content: serialize(v) }))
  if (!list.length) return
  const r = await agent(withCtx(SCRIBE_PROMPT, { writes: list }), {
    label: `scribe:${label}`, model: 'haiku', effort: 'low', schema: SCRIBE_SCHEMA,
  })
  const got = new Map(((r && r.files) || []).map(f => [f.path, f]))
  for (const w of list) {
    const f = got.get(w.path)
    if (!f || f.sha256 !== sha256(w.content)) stop('error', `write-hash-mismatch: ${w.path}`)
  }
  // The scribe could hash the content without writing it. The runner, a separate
  // agent, reads the file back from disk.
  const checks = await run(`verify:${label}`, list.map(w => ({ cmd: `shasum -a 256 ${q(w.path)} && wc -c < ${q(w.path)}`, cwd: '/' })))
  list.forEach((w, i) => {
    const [hash, bytes] = [checks[i].tail.match(/\b[0-9a-f]{64}\b/), checks[i].tail.trim().split(/\s+/).pop()]
    if (checks[i].exit !== 0 || !hash || hash[0] !== sha256(w.content) || Number(bytes) !== byteLength(w.content)) {
      stop('error', `write-hash-mismatch on disk: ${w.path}`)
    }
  })
}

// ---------- judge ----------

const JUDGE_PROMPT =
  'You are the forge judge. Each item in FORGE_CTX.items pairs a spec clause with a test that claims ' +
  'to check it. You see no implementation, on purpose; do not look for one and do not use tools. ' +
  'For each item return one verdict, keyed by the item\'s `ref`:\n' +
  '- valid: the test fails for any implementation that violates the clause and passes for one that meets it.\n' +
  '- too_weak: a wrong implementation could still pass (e.g. the clause expects 401, the test asserts only "not 200").\n' +
  '- overreach: the test demands behavior the clause does not state.\n' +
  '- wrong_oracle: the expected value contradicts the clause.'
const JUDGE_SCHEMA = obj({
  verdicts: arr(obj({ ref: str, verdict: { type: 'string', enum: ['valid', 'too_weak', 'overreach', 'wrong_oracle'] } })),
})

export const clauseView = c => ({ id: c.id, kind: c.kind, input: c.input, action: c.action, expected: c.expected })

// Returns one verdict per item, in order; an item the judge skipped is 'missing'.
// Verdicts bind to a ref, not a test name: two items may share a name.
export async function judge(label, list) {
  const items = list.map((item, i) => ({ ref: String(i + 1), ...item }))
  const r = await agent(withCtx(JUDGE_PROMPT, { items }), {
    label: `judge:${label}`, model: 'opus', effort: 'medium', schema: JUDGE_SCHEMA,
  })
  const verdicts = (r && r.verdicts) || []
  return items.map(i => {
    const v = verdicts.find(x => x.ref === i.ref)
    return v ? v.verdict : 'missing'
  })
}

// ---------- role schemas ----------

const clauseSchema = obj({ id: str, kind: str, input: str, action: str, expected: str, source: str })
export const SCOUT_SCHEMA = obj({
  files: arr(str), helpers: arr(str), conventions: str,
  signals: arr(obj({ id: { type: 'string', enum: ['persistence', 'auth', 'money', 'concurrency', 'untrusted-input', 'public-api', 'data-loss'] }, where: str })),
  commands: obj({ install: { type: ['string', 'null'] }, test: str, fast: str, typecheck: { type: ['string', 'null'] }, lint: { type: ['string', 'null'] } }),
})
export const PLAN_SCHEMA = obj({
  slices: arr(obj({
    id: str, title: str, files: arr(str), spec: arr(clauseSchema),
    acceptance: arr(obj({ clause: str, level: { type: 'string', enum: ['unit', 'integration', 'e2e'] } })),
    structure: str, depends_on: arr(str), notes: { type: 'string', maxLength: 600 },
  }, ['id', 'title', 'files', 'spec', 'acceptance', 'structure', 'depends_on', 'notes'])),
  rejected: arr(obj({ id: str, reason: str })),
})
export const CRITIC_SCHEMA = obj({ verdicts: arr(obj({ clause: str, verdict: str })) })
export const BUILDER_A_SCHEMA = obj({
  tests: arr(obj({ clause: str, file: str, name: str, lines: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 } })),
})
export const DONE_SCHEMA = obj({ done: { type: 'boolean' } })
export const RED_SCHEMA = obj({
  bugs: arr(obj({ id: str, clause: str, variants: { type: 'array', items: obj({ file: str, name: str }), minItems: 2, maxItems: 2 } })),
})
export const BLUE_SCHEMA = obj({
  results: arr(obj({ bug: str, outcome: { type: 'string', enum: ['fixed', 'reject'] }, clause: str })),
})
export const REVIEW_SCHEMA = obj({
  findings: arr(obj({ file: str, line: { type: 'integer' }, category: str, blocking: { type: 'boolean' }, summary: str })),
})
