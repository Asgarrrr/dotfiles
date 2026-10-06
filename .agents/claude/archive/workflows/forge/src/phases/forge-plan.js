export const meta = {
  name: 'forge-plan',
  description: 'forge phase: typed-clause plan, mechanical checks, clause critic',
}
// @lib

const PLANNER_PROMPT =
  'You are the forge planner. Plan FORGE_CTX.task for the repository the scout described in FORGE_CTX.scout. ' +
  'Return vertical slices, walking skeleton first; each slice touches data, behavior and test end to end. ' +
  'Each slice carries typed clauses — the contract every later phase binds to. A clause is ' +
  '{id "S<n>.<m>", kind, input, action, expected, source}; `expected` is exact (a status code, a value), never "an error". ' +
  'Kinds: behavior (new, must fail before the change), negative (what must NOT happen), preserve (existing ' +
  'behavior that must survive), migration, concurrency, property. ' +
  'Every slice must hold a clause of the kind each risk signal in FORGE_CTX.signals requires: ' +
  'auth, money, data-loss → negative; persistence → migration or negative; concurrency → concurrency; ' +
  'untrusted-input → property or negative; public-api → preserve. ' +
  'If FORGE_CTX.feedback is set, it lists problems with your previous plan: fix exactly those.'
const CRITIC_PROMPT =
  'You are the forge clause critic. For each clause in FORGE_CTX.clauses return one verdict: ok, ambiguous ' +
  '(two readings lead to different tests), untestable (no executable check can decide it), or ' +
  'contradicts:<id> (conflicts with another clause). Judge each clause as written; do not rewrite it.'

const { task, scout, signals = [], tier } = args
const out = { ledger: [] }
let asked = 0

const ask = feedback => agent(withCtx(PLANNER_PROMPT, { task, scout, signals, feedback }), {
  label: `planner:${++asked}`, model: 'opus', effort: tier === 'S' ? 'medium' : 'xhigh', schema: PLAN_SCHEMA,
})

async function critique(plan) {
  const clauses = plan.slices.flatMap(s => s.spec.map(clauseView))
  const r = await agent(withCtx(CRITIC_PROMPT, { clauses }), { label: 'critic', model: 'sonnet', effort: 'medium', schema: CRITIC_SCHEMA })
  const verdicts = (r && r.verdicts) || []
  return clauses
    .map(c => ({ clause: c.id, verdict: (verdicts.find(v => v.clause === c.id) || { verdict: 'missing' }).verdict }))
    .filter(v => v.verdict !== 'ok')
}

return await guard(out, async () => {
  let plan = await ask(null)
  let problems = checkPlan(plan, { signals })
  if (problems.length) {
    out.ledger.push(ledgerLine('failed', `plan check: ${problems.join('; ')}`))
    plan = await ask({ problems })
    problems = checkPlan(plan, { signals })
  }
  out.plan = plan
  if (problems.length) stop('escalated', `plan check failed twice: ${problems.join('; ')}`)

  let flagged = await critique(plan)
  if (flagged.length) {
    out.ledger.push(ledgerLine('failed', `clause check: ${flagged.map(f => `${f.clause} ${f.verdict}`).join(', ')}`))
    plan = await ask({ critic: flagged })
    problems = checkPlan(plan, { signals })
    out.plan = plan
    if (problems.length) stop('escalated', `plan check failed after the critic round: ${problems.join('; ')}`)
    flagged = await critique(plan)
  }
  // No checkpoint shows these at low risk, so a clause still flagged stops the run.
  if (flagged.length) stop('escalated', `clauses still flagged: ${flagged.map(f => `${f.clause} ${f.verdict}`).join(', ')}`)
  const count = plan.slices.reduce((n, s) => n + s.spec.length, 0)
  out.ledger.push(ledgerLine('verified', `plan: ${plan.slices.length} slice(s), ${count} clause(s) pass the plan and clause checks`))
  return out
})
