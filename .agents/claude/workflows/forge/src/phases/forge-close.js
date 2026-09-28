export const meta = {
  name: 'forge-close',
  description: 'forge phase: full suite, typecheck and lint at the final commit, targeted review, report',
}
// @lib

const REVIEW_PROMPT =
  'Review the committed range FORGE_CTX.range in FORGE_CTX.dir — run `git diff <range>` yourself; the ' +
  'working tree is clean on purpose. Tests already prove the clauses in FORGE_CTX.clauses. Look only for ' +
  'what tests cannot see: files or changes outside the slice scope, speculative structure (would anything ' +
  'break if it were deleted?), residue, security issues no test covers, and any change not traceable to a ' +
  'clause. Mark a finding blocking only if it must be fixed before merge.'

const { paths: P, commands, base, records = [], plan, dismissed = [], signals = [], baselineFailing = [] } = args
const out = { ledger: [] }

function report(final, extra, findings) {
  const lines = [`# forge report — ${P.branch}`, '', `Base ${base.slice(0, 7)} · final suite \`${commands.test}\` → ${final.exit}`]
  for (const x of extra) lines.push(`${x.name} \`${x.cmd}\` → ${x.exit}`)
  if (signals.length) lines.push('', `Risk signals: ${signals.map(s => `${s.id} (${s.where})`).join(', ')}`)
  if (dismissed.length) lines.push(`Dismissed: ${dismissed.map(d => `${d.id} — ${d.reason}`).join('; ')}`)
  for (const rec of records) {
    const slice = plan.slices.find(s => s.id === rec.id)
    lines.push('', `## ${rec.id} — ${slice ? slice.title : ''}`, '', '| clause | kind | test | at A | at B |', '|---|---|---|---|---|')
    for (const a of rec.atA) {
      const b = rec.atB.find(x => x.test === a.test && x.file === a.file)
      lines.push(`| ${a.clause} | ${a.kind} | ${a.test} | ${a.outcome} | ${b ? b.outcome : '—'} |`)
    }
    for (const r of (rec.duel && rec.duel.rounds) || []) {
      lines.push('', `Red round ${r.round}: ${r.bugs.length ? r.bugs.map(b => `${b.id} (${b.clause}) ${b.status}`).join(', ') : 'no bug found'}`)
    }
    if (rec.outOfScope.length) lines.push(`Out of scope: ${rec.outOfScope.join(', ')}`)
  }
  lines.push('', `## Review`, '')
  lines.push(...(findings.length ? findings.map(f => `- ${f.blocking ? '**blocking** ' : ''}${f.file}:${f.line} [${f.category}] ${f.summary}`) : ['No findings.']))
  return `${lines.join('\n')}\n`
}

return await guard(out, async () => {
  const final = await runTests('final', { cwd: P.main, testCmd: commands.test, runDir: P.runDir })
  const [head] = await runOk('close:head', [{ cmd: 'git rev-parse HEAD', cwd: P.main }])
  const sha = shaOf(head.tail)
  out.ledger.push(ledgerLine('verified', `final ${commands.test} → ${final.exit}`, sha))
  const checks = [['typecheck', commands.typecheck], ['lint', commands.lint]].filter(([, cmd]) => cmd)
  const extra = checks.length
    ? (await run('close:checks', checks.map(([, cmd]) => ({ cmd, cwd: P.main })))).map((r, i) => ({ name: checks[i][0], cmd: checks[i][1], exit: r.exit }))
    : []
  for (const x of extra) out.ledger.push(ledgerLine(x.exit === 0 ? 'verified' : 'failed', `${x.cmd} → ${x.exit}`, sha))

  const clauses = plan.slices.flatMap(s => s.spec.map(clauseView))
  const review = await agent(withCtx(REVIEW_PROMPT, { dir: P.main, range: `${base}..${P.branch}`, clauses }), {
    label: 'reviewer:close', agentType: 'reviewer', model: 'opus', effort: 'high', schema: REVIEW_SCHEMA,
  })
  const findings = (review && review.findings) || []
  out.report = report(final, extra, findings)

  if (!suiteOk(final, baselineFailing)) stop('failed', `final suite ${commands.test} → ${final.exit} with failures outside the baseline`)
  if (extra.some(x => x.exit !== 0)) stop('failed', `close checks failed: ${extra.filter(x => x.exit !== 0).map(x => x.name).join(', ')}`)
  const blocking = findings.filter(f => f.blocking)
  if (blocking.length) stop('escalated', `review: ${blocking.length} blocking finding(s) — see report.md`)
  return out
})
