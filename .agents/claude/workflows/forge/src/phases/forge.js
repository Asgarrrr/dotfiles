export const meta = {
  name: 'forge',
  description: 'Proof-first coding pipeline: triage, typed-clause plan, judged tests at A, build B, red/blue duel, close',
  whenToUse: 'Any coding task in a git repo. args: {task, dir: "/abs/repo", runId: "2026-09-28-slug", gpt, tier, dismiss: ["<signal>: <reason>"], allowRed, until}. Works in a sibling worktree, never in your checkout; nothing merges automatically.',
  phases: [
    { title: 'Triage', detail: 'run worktree, scout, baseline, size and risk' },
    { title: 'Plan', detail: 'typed clauses, mechanical checks, clause critic' },
    { title: 'Build', detail: 'tests at A judged blind, implementation at B' },
    { title: 'Duel', detail: 'red attacks at A, judge, blue fixes, held-out recheck' },
    { title: 'Close', detail: 'full suite, targeted review, report' },
  ],
}
// @lib

const A = args && typeof args === 'object' ? args : {}
const ledger = []
let P = null
let runRec = null

const finish = (s, extra = {}) => ({ runId: A.runId, runDir: P ? P.runDir : null, ...s, ...extra })

// The orchestrator is the only writer (SPEC §2.5): one scribe call per phase boundary.
async function save(label, files) {
  const writes = {}
  for (const [rel, v] of Object.entries(files)) writes[`${P.runDir}/${rel}`] = v
  writes[`${P.runDir}/ledger.md`] = `${ledger.join('\n')}\n`
  await persist(label, writes)
}

async function step(name, childArgs) {
  const res = await workflow(name, childArgs)
  if (!res) stop('error', `${name} returned nothing`)
  ledger.push(...(res.ledger || []))
  if (res.stop) ledger.push(ledgerLine(res.stop.status === 'error' ? 'error' : 'failed', res.stop.reason, runRec && runRec.lastSha))
  return res
}

const sliceStatus = s => (s.status === 'error' ? 'failed' : s.status)

try {
  if (!A.runId || !/^[\w.-]+$/.test(String(A.runId))) stop('error', 'args.runId is required ([A-Za-z0-9._-]); scripts cannot read the clock')
  if (!A.dir || !String(A.dir).startsWith('/')) stop('error', 'args.dir must be an absolute path to the repo')
  P = paths(A.dir, A.runId)
  if (A.resume || A.approve) stop('error', 'not implemented in M1: resume and approve')
  if (!A.task) stop('error', 'args.task is required on a new run')
  let dismissed
  try { dismissed = parseDismiss(A.dismiss) } catch (e) { stop('error', e.message) }
  const allowRed = A.allowRed === true || A.allowRed === 'true'
  const until = A.until == null || A.until === '' ? Infinity : Number(A.until)
  if (!(until === Infinity || (Number.isInteger(until) && until >= 1))) stop('error', `args.until must be a positive integer, got ${JSON.stringify(A.until)}`)
  if (A.tier != null && !['S', 'M', 'L'].includes(A.tier)) stop('error', `args.tier must be S, M or L, got ${JSON.stringify(A.tier)}`)

  phase('Triage')
  const tri = await step('forge-triage', { task: A.task, paths: P, dismissed, allowRed, tier: A.tier })
  runRec = { runId: A.runId, phase: 'triage', status: tri.stop ? tri.stop.status : 'running', tier: tri.tier, risk: tri.risk, signals: tri.signals, base: tri.base, lastSha: tri.base, worktree: P.main }
  await save('triage', { 'run.json': runRec, ...(tri.triage ? { 'triage.json': tri.triage } : {}), ...(tri.scout ? { 'scout.json': tri.scout } : {}) })
  if (tri.stop) return finish(tri.stop)
  const commands = tri.triage.commands
  let dose = dosing(runRec.tier, runRec.risk)
  const why = runRec.signals.map(s => `${s.id}: ${s.where}`).join(', ')
  log(`${runRec.tier} · ${runRec.risk}${why ? ` (${why})` : ''} · ${dose.council ? 'council + ' : ''}plan · ${dose.attackers.length} attacker(s)`)
  if (dose.council) stop('error', 'not implemented in M1: council')

  phase('Plan')
  const pl = await step('forge-plan', { task: A.task, scout: tri.scout, signals: runRec.signals, tier: runRec.tier })
  runRec.phase = 'plan'
  if (pl.plan) runRec.planHash = sha256(serialize(pl.plan))
  await save('plan', { 'run.json': runRec, ...(pl.plan ? { 'plan.json': pl.plan } : {}) })
  if (pl.stop) return finish(pl.stop)
  const plan = pl.plan

  // Second re-triage: the plan's real file count can only raise the tier.
  const planTier = raiseTier(runRec.tier, sizeOf(plan.slices.flatMap(s => s.files)))
  if (planTier !== runRec.tier) {
    ledger.push(ledgerLine('decision', `re-triage from plan: ${runRec.tier} → ${planTier}`, runRec.lastSha))
    runRec.tier = planTier
    const next = dosing(planTier, runRec.risk)
    if (next.council && !dose.council) stop('error', 'not implemented in M1: council after re-triage')
    dose = next
  }
  if (dose.shadow || dose.checkpointAfterPlan) stop('error', 'not implemented in M1: shadow planner and plan checkpoint')

  const records = []
  for (const slice of plan.slices.slice(0, until)) {
    phase('Build')
    const b = await step('forge-build', { slice, paths: P, testCmd: commands.test })
    if (b.stop) b.slice.status = sliceStatus(b.stop)
    if (b.slice.commits.B) runRec.lastSha = b.slice.commits.B
    runRec.phase = `build:${slice.id}`
    await save(`build-${slice.id}`, { 'run.json': runRec, [`slices/${slice.id}.json`]: b.slice })
    if (b.stop) return finish(b.stop)

    phase('Duel')
    const d = await step('forge-duel', { slice, record: b.slice, paths: P, runId: A.runId, testCmd: commands.test, attackers: dose.attackers, mutation: dose.mutation, round: 1 })
    d.slice.status = d.stop ? sliceStatus(d.stop) : 'done'
    if (d.head) runRec.lastSha = d.head
    runRec.phase = `duel:${slice.id}`
    await save(`duel-${slice.id}`, { 'run.json': runRec, [`slices/${slice.id}.json`]: d.slice })
    if (d.stop) return finish(d.stop)
    records.push(d.slice)
  }

  phase('Close')
  const c = await step('forge-close', { paths: P, commands, base: runRec.base, records, plan, dismissed, signals: runRec.signals })
  runRec.phase = 'close'
  runRec.status = c.stop ? c.stop.status : 'done'
  await save('close', { 'run.json': runRec, ...(c.report ? { 'report.md': c.report } : {}) })
  if (c.stop) return finish(c.stop)
  return finish({ status: 'done' }, { branch: P.branch, worktree: P.main, slices: records.map(r => r.id), report: c.report })
} catch (e) {
  if (!(e && e.forge)) throw e
  // A stop raised here, not in a phase, still belongs in the ledger — unless the
  // scribe itself is what failed.
  if (runRec && !e.forge.reason.startsWith('write-hash-mismatch')) {
    ledger.push(ledgerLine(e.forge.status === 'error' ? 'error' : 'failed', e.forge.reason, runRec.lastSha))
    runRec.status = e.forge.status
    try { await save('stop', { 'run.json': runRec }) } catch (e2) { if (!(e2 && e2.forge)) throw e2 }
  }
  return finish(e.forge)
}
