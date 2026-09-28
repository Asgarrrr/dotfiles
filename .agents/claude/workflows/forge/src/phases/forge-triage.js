export const meta = {
  name: 'forge-triage',
  description: 'forge phase: run worktree, scout, baseline, size and risk',
}
// @lib

const SCOUT_PROMPT =
  'You are the forge scout. Read the repository at FORGE_CTX.dir to prepare this task: FORGE_CTX.task. ' +
  'Report facts, never verdicts: the files the task likely touches, reusable helpers, conventions, and ' +
  'the exact commands to install dependencies, run the test suite, a fast subset, typecheck and lint (null if absent). ' +
  'List every risk signal, each with its `file:line`, or "task" when only the task text implies it: ' +
  'persistence, auth, money, concurrency, untrusted-input, public-api, data-loss.'

const { task, paths: P, dismissed = [], allowRed = false, tier: forced } = args
const out = { ledger: [] }

return await guard(out, async () => {
  const [head] = await runOk('triage:head', [{ cmd: 'git rev-parse HEAD', cwd: P.dir }])
  const base = shaOf(head.tail)
  out.base = base
  // The run dir lives in the user's repo; excluding it keeps their checkout clean.
  await runOk('triage:worktree', [
    { cmd: `f=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$f")" && { grep -qxF '/.claude/' "$f" || echo '/.claude/' >> "$f"; }`, cwd: P.dir },
    { cmd: `mkdir -p ${q(P.wtRoot)} && git worktree add -q ${q(P.main)} -b ${q(P.branch)} ${base}`, cwd: P.dir },
  ])

  const scout = await agent(withCtx(SCOUT_PROMPT, { task, dir: P.main }), {
    label: 'scout', model: 'sonnet', effort: 'medium', schema: SCOUT_SCHEMA,
  })
  if (!scout) stop('error', 'scout returned nothing')
  out.scout = scout
  const testCmd = scout.commands && scout.commands.test
  if (!testCmd) stop('escalated', 'scout found no test command')
  if (scout.commands.install) await runOk('triage:install', [{ cmd: scout.commands.install, cwd: P.main, tail: 3000 }])

  const [ls] = await runOk('triage:files', [{ cmd: 'git ls-files', cwd: P.main, tail: 400000 }])
  const protectedFiles = ls.tail.split('\n').filter(isProtected)
  const baseline = await runTests('base', { cwd: P.main, testCmd, runDir: P.runDir })
  const failing = baseline.cases.filter(c => c.outcome === 'fail').map(c => `${c.file} › ${c.name}`)
  out.ledger.push(ledgerLine('verified', `baseline ${testCmd} → ${baseline.exit}`, base))

  const { risk, signals } = riskOf(scout.signals || [], dismissed.map(d => d.id))
  for (const d of dismissed) out.ledger.push(ledgerLine('dismissed', `${d.id}: ${d.reason}`, base))
  let tier = sizeOf(scout.files || [])
  if (forced && forced !== tier) {
    out.ledger.push(ledgerLine('decision', `tier forced ${tier} → ${forced}`, base))
    tier = forced
  }
  Object.assign(out, { tier, risk, signals })
  out.triage = { base, tier, risk, signals, dismissed, commands: scout.commands, protectedFiles, baseline: { exit: baseline.exit, failing, tail: baseline.tail } }
  if (baseline.exit !== 0 && !allowRed) stop('blocked', `red baseline: ${failing.length} failing test(s); pass allowRed to run anyway`)
  return out
})
