export const meta = {
  name: 'forge-build',
  description: 'forge phase: one test per clause at commit A, judged blind, then the implementation at commit B',
}
// @lib

const BUILDER_A_PROMPT =
  'Stage A of a forge slice. In FORGE_CTX.worktree, write one test per clause of FORGE_CTX.slice.spec, ' +
  'plus stubs so the tests compile and run: signatures only, bodies that throw "not implemented". ' +
  'No implementation. Each test name starts with its clause id. behavior, negative, migration, concurrency ' +
  'and property tests must fail against the stubs; preserve tests must pass today. Do not commit, and do ' +
  'not touch test config, package scripts, lockfiles or CI. Return, per clause, the test file, the test ' +
  'name, and the [first, last] line numbers of the whole test block. If FORGE_CTX.retry is set, the judge ' +
  'rejected those tests: strengthen exactly those.'
const BUILDER_B_PROMPT =
  'Stage B of a forge slice. In FORGE_CTX.worktree, implement FORGE_CTX.slice so every test in ' +
  'FORGE_CTX.tests passes, with the smallest change that does it. Do not edit those tests, do not commit, ' +
  'and do not touch test config, package scripts, lockfiles or CI. If FORGE_CTX.failures is set, your ' +
  'previous attempt left those tests failing; the tail is the suite output.'

const { slice, paths: P, testCmd, head, baselineFailing = [] } = args
const rec = { id: slice.id, status: 'running', commits: {}, judge: [], atA: [], atB: [], protectedTouched: [], outOfScope: [] }
const out = { ledger: [], slice: rec }
const clauses = Object.fromEntries(slice.spec.map(c => [c.id, c]))
const mustFailAtA = kind => kind !== 'preserve'

async function checkChanges(label, expectedHead) {
  const { changed, touched } = await protectedChanges(label, P.main, expectedHead)
  if (touched.length) {
    rec.protectedTouched = touched
    stop('blocked', `${slice.id} touched protected file(s): ${touched.join(', ')}`)
  }
  for (const f of changed) if (!slice.files.includes(f) && !rec.outOfScope.includes(f)) rec.outOfScope.push(f)
}

const row = (t, outcome) => ({ test: t.name, file: t.file, clause: t.clause, kind: clauses[t.clause].kind, outcome })

return await guard(out, async () => {
  let tests = []
  let retry = null
  for (let attempt = 1; ; attempt++) {
    const res = await agent(withCtx(BUILDER_A_PROMPT, { stage: 'A', worktree: P.main, slice, retry }), {
      label: `builder:${slice.id}:A${attempt}`, agentType: 'implementer', model: 'opus', effort: 'high', schema: BUILDER_A_SCHEMA,
    })
    tests = ((res && res.tests) || []).filter(t => clauses[t.clause])
    await checkChanges(`${slice.id} builder A${attempt}`, head)
    const missing = slice.spec.filter(c => !tests.some(t => t.clause === c.id)).map(c => ({ clause: c.id, verdict: 'missing' }))
    let bad = missing
    if (!missing.length) {
      // The judge sees the test block only, extracted by the runner — never the stub.
      const sources = await runOk(`sources:${slice.id}:A${attempt}`, tests.map(t => ({
        cmd: `sed -n ${Number(t.lines[0])},${Number(t.lines[1])}p ${q(t.file)}`, cwd: P.main, tail: 20000,
      })))
      // The builder reports the line range; a block that does not hold the named
      // test would let the judge rate a different, stronger test.
      const misplaced = tests.filter((t, i) => !sources[i].tail.includes(t.name))
      const items = tests.map((t, i) => ({ clause: clauseView(clauses[t.clause]), test: t.name, source: sources[i].tail }))
      const verdicts = (await judge(`${slice.id}:A${attempt}`, items)).map((v, i) => (misplaced.includes(tests[i]) ? 'misplaced' : v))
      tests.forEach((t, i) => rec.judge.push({ test: t.name, clause: t.clause, verdict: verdicts[i], attempt }))
      for (const [i, v] of verdicts.entries()) if (v === 'overreach') out.ledger.push(ledgerLine('gap', `${slice.id} ${tests[i].clause}: builder test overreaches the clause`))
      bad = tests.map((t, i) => ({ clause: t.clause, test: t.name, verdict: verdicts[i] }))
        .filter(x => ['too_weak', 'wrong_oracle', 'missing', 'misplaced'].includes(x.verdict))
    }
    if (!bad.length) break
    if (attempt === 2) stop('escalated', `${slice.id} builder tests rejected twice: ${bad.map(b => `${b.clause} ${b.verdict}`).join(', ')}`)
    retry = bad
  }

  rec.commits.A = await commit(`commit:${slice.id}:A`, P.main, `${slice.id} tests`)
  const atA = await runTests(`${slice.id}-A`, { cwd: P.main, testCmd, runDir: P.runDir })
  rec.atA = tests.map((t, i) => row(t, outcomes(tests, atA.cases)[i]))
  const wrongAtA = rec.atA.filter(r => (mustFailAtA(r.kind) ? r.outcome !== 'fail' : r.outcome !== 'pass'))
  if (wrongAtA.length) {
    stop('failed', `${slice.id} at A: ${wrongAtA.map(r => `${r.clause} ${r.outcome} (${r.kind} must ${mustFailAtA(r.kind) ? 'fail' : 'pass'})`).join(', ')}`)
  }
  out.ledger.push(ledgerLine('verified', `${slice.id} at A: ${rec.atA.length} clause test(s) fail or pass as their kind requires`, rec.commits.A))

  let failures = null
  for (let attempt = 1; ; attempt++) {
    await agent(withCtx(BUILDER_B_PROMPT, { stage: 'B', worktree: P.main, slice, tests, failures }), {
      label: `builder:${slice.id}:B${attempt}`, agentType: 'implementer', model: 'opus', effort: 'high', schema: DONE_SCHEMA,
    })
    // Attempt 2 amends B on the run's private branch, so B~1 stays A.
    await checkChanges(`${slice.id} builder B${attempt}`, attempt > 1 ? rec.commits.B : rec.commits.A)
    rec.commits.B = await commit(`commit:${slice.id}:B${attempt}`, P.main, `${slice.id} impl`, { amend: attempt > 1 })
    const edited = await editedBetween(`tamper:${slice.id}:B${attempt}`, P.main, rec.commits.A, rec.commits.B, [...new Set(tests.map(t => t.file))])
    if (edited.length) stop('blocked', `${slice.id} tamper: builder B edited clause test file(s) ${edited.join(', ')}`)
    const atB = await runTests(`${slice.id}-B${attempt}`, { cwd: P.main, testCmd, runDir: P.runDir })
    rec.atB = tests.map((t, i) => row(t, outcomes(tests, atB.cases)[i]))
    const failing = rec.atB.filter(r => r.outcome !== 'pass')
    if (!failing.length && suiteOk(atB, baselineFailing)) {
      out.ledger.push(ledgerLine('verified', `${testCmd} → ${atB.exit}, no failure outside the baseline`, rec.commits.B))
      break
    }
    out.ledger.push(ledgerLine('failed', `${slice.id} attempt ${attempt} at B: ${testCmd} → ${atB.exit}, ${failing.length} clause test(s) not passing`, rec.commits.B))
    if (attempt === 2) stop('failed', `${slice.id} still failing at B after 2 attempts`)
    failures = { tests: failing.map(r => r.test), tail: atB.tail }
  }
  rec.status = 'built'
  return out
})
