export const meta = {
  name: 'forge-duel',
  description: 'forge phase: red attacks at commit A, judge on variant 1, blue fixes, recheck with the held-out variant 2',
}
// @lib

const RED_PROMPT =
  'You are a forge red attacker. FORGE_CTX.worktree is checked out at the commit holding the tests and stubs ' +
  'for FORGE_CTX.slice — the implementation is deliberately absent. Find up to 5 ways an implementation could ' +
  'meet every existing test yet violate a clause of the slice spec. For each bug write TWO independent test ' +
  'variants, each in a NEW test file (never edit an existing file), each asserting the clause on different ' +
  'inputs. Cite the clause id. Do not commit. Return each bug with its clause and its two {file, name} variants.'
const BLUE_PROMPT =
  'You are the forge blue fixer. Each bug in FORGE_CTX.bugs comes with a failing test that a judge confirmed ' +
  'against its clause. In FORGE_CTX.worktree, fix the root cause in the implementation so the clause holds for ' +
  'every input, not just the one tested. Never edit a test file. Do not commit. If a bug is not a real ' +
  'violation of its clause, return outcome "reject" for it instead of changing code.'

const { slice, record: rec, paths: P, runId, testCmd, attackers, mutation, round = 1 } = args
const out = { ledger: [], slice: rec }
rec.duel = rec.duel || { rounds: [] }
const R = { round, bugs: [] }
rec.duel.rounds.push(R)
const clauseIds = new Set(slice.spec.map(c => c.id))
const clauses = Object.fromEntries(slice.spec.map(c => [c.id, c]))
const temp = []
const tag = a => `${slice.id}-r${round}-a${a}`
const key = b => `a${b.attacker}/${b.id}`

async function worktreeAt(label, path, sha) {
  temp.push(path)
  await runOk(label, [{ cmd: `git worktree add -q --detach ${q(path)} ${sha}`, cwd: P.main }])
}

// A scratch tree at `sha` with the given red files checked out and committed, so
// the clean-tree rule holds for the test run.
async function scratchRun(label, sha, picks) {
  const path = `${P.wtRoot}/scratch-${label}`
  await worktreeAt(`scratch:${label}`, path, sha)
  const cmds = picks.map(p => ({ cmd: `git checkout ${p.sha} -- ${p.files.map(q).join(' ')}`, cwd: path }))
  cmds.push({ cmd: `git add -A && git commit -q --allow-empty -m ${q(`scratch ${label}`)}`, cwd: path })
  await runOk(`scratch:${label}:checkout`, cmds)
  return runTests(label, { cwd: path, testCmd, runDir: P.runDir })
}

const byAttacker = bugs => {
  const m = new Map()
  for (const b of bugs) m.set(b.sha, [...(m.get(b.sha) || []), b])
  return m
}

const record = (b, fields) => {
  const row = { id: b.id, attacker: b.attacker, clause: b.clause, verdict: b.verdict || null, status: null, ...fields }
  R.bugs.push(row)
  return row
}

async function attack() {
  await runOk(`red:worktrees:${slice.id}-r${round}`, attackers.map((_, i) => {
    const path = `${P.wtRoot}/red-${tag(i + 1)}`
    temp.push(path)
    return { cmd: `git worktree add -q --detach ${q(path)} ${rec.commits.A}`, cwd: P.main }
  }))
  const results = await Promise.all(attackers.map((model, i) => agent(
    withCtx(RED_PROMPT, { worktree: `${P.wtRoot}/red-${tag(i + 1)}`, slice, round, attacker: i + 1 }),
    { label: `red:${slice.id}:r${round}:a${i + 1}`, model, effort: 'high', schema: RED_SCHEMA },
  )))
  const found = []
  for (const [i, res] of results.entries()) {
    const bugs = ((res && res.bugs) || []).slice(0, 5)
    if (!bugs.length) continue
    const wt = `${P.wtRoot}/red-${tag(i + 1)}`
    const [, , names, head] = await runOk(`red:commit:${tag(i + 1)}`, [
      { cmd: `git checkout -q -b ${q(`forge/${runId}/red-${tag(i + 1)}`)}`, cwd: wt },
      { cmd: `git add -A && git commit -q --allow-empty -m ${q(`red ${tag(i + 1)}`)}`, cwd: wt },
      { cmd: 'git diff --name-status HEAD~1 HEAD', cwd: wt, tail: 100000 },
      { cmd: 'git rev-parse HEAD', cwd: wt },
    ])
    const status = new Map(names.tail.split('\n').filter(Boolean).map(l => { const [s, ...f] = l.split('\t'); return [f.join('\t'), s] }))
    const sha = shaOf(head.tail)
    for (const b of bugs) {
      const files = (b.variants || []).map(v => v.file)
      // Red may only add files; moving them onto B or main is then conflict-free.
      const ok = clauseIds.has(b.clause) && files.length === 2 && files[0] !== files[1] && files.every(f => status.get(f) === 'A')
      if (!ok) { record({ ...b, attacker: i + 1 }, { status: 'dropped', note: 'must cite a slice clause and add two new files' }); continue }
      found.push({ ...b, attacker: i + 1, sha, v1: b.variants[0], v2: b.variants[1] })
    }
  }
  return found
}

return await guard(out, async () => {
  try {
    const found = await attack()
    if (!found.length) {
      out.ledger.push(ledgerLine('verified', `${slice.id} round ${round}: no bug from ${attackers.length} attacker(s)`, rec.commits.B))
      if (mutation) out.ledger.push(ledgerLine('decision', `${slice.id} mutation: skipped (not implemented in M1)`))
      return out
    }

    // Keep pairs whose two variants both fail correctly against B.
    const atB = await scratchRun(`${slice.id}-r${round}-B`, rec.commits.B, [...byAttacker(found)].map(([sha, bs]) => ({ sha, files: bs.flatMap(b => [b.v1.file, b.v2.file]) })))
    const failing = found.filter(b => outcomes([b.v1, b.v2], atB.cases).every(o => o === 'fail'))
    for (const b of found) if (!failing.includes(b)) record(b, { status: 'dropped', note: 'variants must both fail at B' })
    if (!failing.length) return out

    const [...sources] = await runOk(`red:sources:${slice.id}-r${round}`, failing.map(b => ({ cmd: `git show ${b.sha}:${q(b.v1.file)}`, cwd: P.main, tail: 20000 })))
    const verdicts = await judge(`${slice.id}:r${round}`, failing.map((b, i) => ({ clause: clauseView(clauses[b.clause]), test: b.v1.name, source: sources[i].tail })))
    const valid = []
    failing.forEach((b, i) => {
      b.verdict = verdicts[i]
      if (b.verdict === 'valid') valid.push(b)
      else if (b.verdict === 'overreach') {
        record(b, { status: 'overreach' })
        out.ledger.push(ledgerLine('gap', `${slice.id} ${b.clause}: red test overreaches the clause — a spec gap for the human`))
      } else record(b, { status: 'discarded' })
    })
    if (!valid.length) return out

    // Only variant 1 lands before the fix; variant 2 stays hidden from blue.
    const v1Files = valid.map(b => b.v1.file)
    await runOk(`red:land:${slice.id}-r${round}`, [...byAttacker(valid)].map(([sha, bs]) => ({ cmd: `git checkout ${sha} -- ${bs.map(b => q(b.v1.file)).join(' ')}`, cwd: P.main })))
    rec.commits.R = await commit(`commit:${slice.id}:R${round}`, P.main, `${slice.id} red r${round}`)

    const blue = await agent(withCtx(BLUE_PROMPT, { worktree: P.main, bugs: valid.map(b => ({ id: key(b), clause: b.clause, file: b.v1.file, name: b.v1.name })) }), {
      label: `blue:${slice.id}:r${round}`, agentType: 'implementer', model: 'opus', effort: 'high', schema: BLUE_SCHEMA,
    })
    const outcome = b => ((blue && blue.results) || []).find(r => r.bug === key(b))
    const { touched } = await protectedChanges(`changes:${slice.id}:F${round}`, P.main)
    if (touched.length) {
      rec.protectedTouched = touched
      stop('blocked', `${slice.id} blue touched protected file(s): ${touched.join(', ')}`)
    }
    rec.commits.F = await commit(`commit:${slice.id}:F${round}`, P.main, `${slice.id} fix r${round}`)

    const [diff] = await runOk(`tamper:${slice.id}-r${round}`, [{ cmd: `git diff --name-only ${rec.commits.R} ${rec.commits.F} -- ${v1Files.map(q).join(' ')}`, cwd: P.main, tail: 100000 }])
    const tampered = diff.tail.split('\n').filter(Boolean)
    if (tampered.length) {
      for (const b of valid) record(b, { status: tampered.includes(b.v1.file) ? 'tamper' : 'unchecked' })
      stop('blocked', `${slice.id} tamper: blue edited red test file(s) ${tampered.join(', ')}`)
    }

    const atF = await scratchRun(`${slice.id}-r${round}-F`, rec.commits.F, [...byAttacker(valid)].map(([sha, bs]) => ({ sha, files: bs.map(b => b.v2.file) })))
    const fixed = []
    for (const b of valid) {
      const [o1, o2] = outcomes([b.v1, b.v2], atF.cases)
      const o = outcome(b)
      const status = o && o.outcome === 'reject' ? 'rejected' : o1 !== 'pass' ? 'unfixed' : o2 !== 'pass' ? 'held-out-failed' : 'fixed'
      record(b, { status })
      if (status === 'fixed') fixed.push(b)
    }
    const clauseRows = (rec.atB || []).filter(r => r.file)
    const regressions = outcomes(clauseRows.map(r => ({ file: r.file, name: r.test })), atF.cases).filter(o => o !== 'pass').length
    if (fixed.length) {
      await runOk(`red:heldout:${slice.id}-r${round}`, [...byAttacker(fixed)].map(([sha, bs]) => ({ cmd: `git checkout ${sha} -- ${bs.map(b => q(b.v2.file)).join(' ')}`, cwd: P.main })))
      out.head = await commit(`commit:${slice.id}:H${round}`, P.main, `${slice.id} red held-out r${round}`)
    } else out.head = rec.commits.F
    const open = R.bugs.filter(b => ['rejected', 'unfixed', 'held-out-failed'].includes(b.status))
    if (open.length || regressions || atF.exit !== 0) {
      stop('escalated', `${slice.id} round ${round}: ${open.map(b => `${b.id} ${b.status}`).join(', ') || 'no open bug'}; ${regressions} clause test(s) regressed; suite → ${atF.exit}`)
    }
    out.ledger.push(ledgerLine('verified', `${slice.id} round ${round}: ${fixed.length} bug(s) fixed, variant 2 held out and passing, suite → 0`, out.head))
    return out
  } finally {
    // Red and scratch trees are evidence only while the phase runs; branches stay.
    if (temp.length) await run(`cleanup:${slice.id}-r${round}`, [...temp.map(t => ({ cmd: `git worktree remove --force ${q(t)}`, cwd: P.main })), { cmd: 'git worktree prune', cwd: P.main }])
  }
})
