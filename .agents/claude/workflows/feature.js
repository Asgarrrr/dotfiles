export const meta = {
  name: 'feature-stage',
  description: 'One stage of the feature workflow (intent, design, contract, build); driven by the /feature skill',
  whenToUse: 'Launched by the /feature skill, one stage per run. args: {stage: "intent", task: "...", dir: "/abs/repo", slug: "kebab-name", today: "YYYY-MM-DD"}. State lives in <dir>/.claude/runs/<slug>/; the skill asks the questions between stages.',
  phases: [
    { title: 'Explore', detail: 'three readers write verbatim path:line excerpts; the gate baseline runs twice', model: 'sonnet' },
    { title: 'Intent', detail: 'task restated, acceptance criteria, non-goals, neutral questions — or needs-human', model: 'opus' },
  ],
}

const A = args && typeof args === 'object' ? args : {}
const STAGES = ['intent']
if (!STAGES.includes(A.stage)) throw new Error(`feature: args.stage must be one of ${STAGES.join(', ')} — got ${JSON.stringify(A.stage)}`)
if (typeof A.dir !== 'string' || !A.dir.startsWith('/')) throw new Error(`feature: args.dir must be an absolute path — got ${JSON.stringify(A.dir)}`)
if (typeof A.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(A.slug)) throw new Error(`feature: args.slug must be kebab-case — got ${JSON.stringify(A.slug)}`)
// Scripts cannot read the clock, and every "latest version" claim is relative to it.
if (typeof A.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(A.today)) throw new Error(`feature: args.today must be YYYY-MM-DD — got ${JSON.stringify(A.today)}`)

const dir = A.dir
const today = A.today
const RUN = `${dir}/.claude/runs/${A.slug}`
const shq = p => `'${String(p).replace(/'/g, `'\\''`)}'`

// --- shell -----------------------------------------------------------------
// The Bash tool caps one call at 600s, so a longer budget would be killed by the
// tool, not by the alarm, and the EXIT line would never print.
const MAX_BUDGET_SEC = 570
const budgetOf = sec => {
  const n = Number(sec) > 0 ? Math.round(Number(sec)) : 300
  if (n > MAX_BUDGET_SEC) log(`budget ${n}s clamped to ${MAX_BUDGET_SEC}s (Bash tool limit)`)
  return Math.min(n, MAX_BUDGET_SEC)
}
// macOS has no timeout(1). The alarm survives exec, so the command dies with
// SIGALRM (exit 142) and a dead process cannot hold the run forever. pipefail is
// set inside the child: a gate written as `x | tail` must fail when x fails.
const timed = (cmd, sec, logFile) =>
  `perl -e 'alarm shift; exec @ARGV' ${budgetOf(sec)} bash -c ${shq(`set -o pipefail; ${cmd}`)} > ${shq(logFile)} 2>&1`
// Read from the last KEY= line: an agent that summarises instead of relaying drops
// the line, and a missing line must read as failure, never as success.
const parseExit = (output, key = 'EXIT') => {
  const m = [...String(output || '').matchAll(new RegExp(`^${key}=(\\d+)\\s*$`, 'gm'))].pop()
  if (!m) return { code: null, status: 'missing' }
  const code = Number(m[1])
  return { code, status: code === 0 ? 'pass' : code === 142 ? 'TIMEOUT' : 'fail' }
}
const OUTPUT = { type: 'object', properties: { output: { type: 'string' } }, required: ['output'] }
const sh = async (name, script, phaseName) => {
  const r = await agent(
    `Run the script below with ONE Bash call, in the foreground (never run_in_background), ` +
    `with the Bash timeout set to 600000 ms. Do not edit it, split it, or run anything else. ` +
    `Return its complete stdout and stderr in output, verbatim, with no comment.\n\n` +
    `--- script ---\n${script}\n--- end ---`,
    { label: `sh:${name}`, phase: phaseName, model: 'sonnet', effort: 'low', schema: OUTPUT })
  return (r && r.output) || ''
}

// --- questions -------------------------------------------------------------
// Options stay neutral so the user weighs them before reading the pick; the
// recommendation and what would flip it live apart.
const QUESTION = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'kebab-case, stable across reruns' },
    question: { type: 'string', description: 'one sentence ending in ?' },
    options: {
      type: 'array', minItems: 2, maxItems: 4,
      items: {
        type: 'object',
        properties: { label: { type: 'string', description: '1-5 words, no "(recommended)"' }, description: { type: 'string', description: 'consequence of this option, stated neutrally' } },
        required: ['label', 'description'],
      },
    },
    recommendation: {
      type: 'object',
      properties: { option: { type: 'string', description: 'label of one option' }, why: { type: 'string' }, wouldChangeIf: { type: 'string', description: 'the fact that would flip the recommendation' } },
      required: ['option', 'why', 'wouldChangeIf'],
    },
  },
  required: ['id', 'question', 'options', 'recommendation'],
}
const NEEDS_HUMAN_RULE =
  `If the task is ill-posed — it contradicts itself, contradicts the code, or cannot be ` +
  `checked — say so with status needs-human, a one-sentence reason, and evidence as verbatim ` +
  `path:line excerpts or quoted output. Saying so is a valid outcome; guessing past it is not.`

// --- stage: intent ---------------------------------------------------------
async function intentStage() {
  const task = A.task
  if (typeof task !== 'string' || !task.trim()) throw new Error('feature: stage intent needs args.task')
  phase('Explore')
  const setup = await sh('setup',
    `cd ${shq(dir)} && ex=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$ex")" && ` +
    `{ grep -qxF '/.claude/runs/' "$ex" 2>/dev/null || echo '/.claude/runs/' >> "$ex"; } && ` +
    `mkdir -p ${shq(`${RUN}/explore`)}\necho "EXIT=$?"`, 'Explore')
  if (parseExit(setup).status !== 'pass') throw new Error(`feature: setup failed — ${setup.slice(-400)}`)

  const EXCERPT_RULE =
    `Write your findings to FILE as markdown. Back every statement about the code with a ` +
    `verbatim excerpt fenced under its path:line, copied from the file, never paraphrased. ` +
    `A later agent trusts this file instead of re-reading the code, so a wrong excerpt ` +
    `becomes a wrong design. Return a digest of at most 10 lines.`
  const DIGEST = { type: 'object', properties: { digest: { type: 'string' } }, required: ['digest'] }
  const GATE = {
    type: 'object',
    properties: {
      digest: { type: 'string' },
      gateCommand: { type: 'string', description: 'one shell command that runs the full test suite from the repo root, quiet reporter if the runner has one; empty if none exists' },
      lintCommand: { type: 'string', description: 'the lint/typecheck command, with dead-code detection enabled if the toolchain has it; empty if none exists' },
    },
    required: ['digest', 'gateCommand', 'lintCommand'],
  }
  const READERS = [
    { key: 'conventions', schema: DIGEST, ask: `the existing architecture and conventions: module boundaries, layering, naming, error handling, how a new unit is usually added. Read the project CLAUDE.md, .claude/rules/, and 2-3 representative modules.` },
    { key: 'code', schema: DIGEST, ask: `the code this task touches: entry points, types, helpers that must be reused, partial implementations, and what must NOT be recreated.` },
    { key: 'gate', schema: GATE, ask: `the gate: how the suite, one single test, lint, and typecheck run (CI config, justfile, package scripts, Cargo aliases), and the manifests and lockfiles in use. Do not run the suite; the script runs it.` },
  ]
  const readers = await parallel(READERS.map(r => () => agent(
    `Repo: ${dir}. Task: ${task}\n\nMap ${r.ask}\n\n` +
    EXCERPT_RULE.replace('FILE', `${RUN}/explore/${r.key}.md`),
    { label: `explore:${r.key}`, phase: 'Explore', model: 'sonnet', effort: 'high', schema: r.schema })))
  const [conv, code, gate] = readers
  if (!conv || !code) throw new Error('feature: an explore reader returned nothing — aborting before intent runs blind')

  // Twice, in sequence: a split result is a flaky suite, and a later stage would
  // otherwise blame a slice for it.
  const runs = []
  if (gate && gate.gateCommand) {
    for (const n of [1, 2]) {
      const logFile = `${RUN}/baseline-${n}.log`
      const out = await sh(`baseline:${n}`,
        `cd ${shq(dir)} && ${timed(gate.gateCommand, 570, logFile)}; echo "EXIT=$?"\ntail -n 40 ${shq(logFile)}`, 'Explore')
      runs.push(parseExit(out).status)
    }
  } else {
    log('explore: no gate command found — baseline unknown')
  }
  const baseline = { command: (gate && gate.gateCommand) || '', lint: (gate && gate.lintCommand) || '', runs, flaky: runs.length === 2 && runs[0] !== runs[1] }
  if (baseline.flaky) log(`baseline is flaky: ${runs.join(' then ')}`)

  phase('Intent')
  const INTENT = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok', 'needs-human'] },
      reason: { type: 'string', description: 'needs-human only: one sentence' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'needs-human only: verbatim path:line excerpts or quoted output' },
      acceptance: {
        type: 'array',
        items: { type: 'object', properties: { criterion: { type: 'string' }, check: { type: 'string', description: 'exact command and expected outcome, or "manual: <what to look at>" when it cannot be automated' } }, required: ['criterion', 'check'] },
      },
      questions: { type: 'array', items: QUESTION, description: 'only the real decisions: ambiguities where two readings lead to different code' },
      digest: { type: 'string', description: 'at most 15 lines for the user' },
    },
    required: ['status', 'reason', 'evidence', 'acceptance', 'questions', 'digest'],
  }
  const intent = await agent(
    `Today is ${today}. Repo: ${dir}.\n\nTask, verbatim:\n--- task ---\n${task}\n--- end ---\n\n` +
    `Read ${RUN}/explore/conventions.md, ${RUN}/explore/code.md and ${RUN}/explore/gate.md. ` +
    `Baseline: \`${baseline.command || 'none'}\` → ${runs.join(', ') || 'not run'}${baseline.flaky ? ' (FLAKY)' : ''}.\n\n` +
    `Write ${RUN}/task.md with these sections: Original (the task verbatim), Restated, ` +
    `Acceptance criteria (executable where possible), Non-goals, Open questions. Restate the ` +
    `task without adding scope: every acceptance criterion must trace to a word in the original. ` +
    `Ask only questions whose answers change the code; resolve the rest from the code and say how.\n\n` +
    NEEDS_HUMAN_RULE,
    { label: 'intent', phase: 'Intent', model: 'opus', effort: 'high', schema: INTENT })
  if (!intent) throw new Error('feature: intent returned nothing')

  if (intent.status === 'needs-human') {
    if (!intent.evidence.length) log('intent: needs-human without evidence — treat the reason as unproven')
    return { stage: 'intent', status: 'needs-human', runDir: RUN, reason: intent.reason, evidence: intent.evidence, baseline, questions: [], digest: intent.digest, next: null }
  }
  return {
    stage: 'intent',
    status: intent.questions.length ? 'questions' : 'ready',
    runDir: RUN, baseline, acceptance: intent.acceptance, questions: intent.questions, digest: intent.digest,
    next: `Append the answers to ${RUN}/task.md under "## Answers", then run stage design.`,
  }
}

const STAGE_FN = { intent: intentStage }
return await STAGE_FN[A.stage]()
