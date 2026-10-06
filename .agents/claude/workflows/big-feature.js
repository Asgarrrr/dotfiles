export const meta = {
  name: 'big-feature',
  description: 'Explore → vet → plan → checkpoint → implement vertical slices → adversarial review',
  whenToUse: 'Large multi-file features or refactors. args: {task: "...", dir: "/abs/path/to/repo", go: false, until: 1, slices: [...], gpt: false, fable: false} (or a plain task string, dir defaults to cwd). fable:true escalates Plan and council to Fable — for novel or large multi-agent work, or after Opus failed twice. Stops after Plan unless go:true. With until:N, stops after N slices so you can read the diff — relaunch with resumeFromRunId and a higher until; finished work replays from cache. In a FRESH session the cache is gone: pass the approved plan back as args.slices with go:true to execute it verbatim, skipping explore/vet/plan.',
  phases: [
    { title: 'Explore', detail: 'three cheap readers map conventions, existing code, and the test surface', model: 'sonnet' },
    { title: 'Vet', detail: 'dependency check, plus a council answering one design question blind; a synthesiser compares by content, then any contested concern goes back to the seat that missed it' },
    { title: 'Plan', detail: 'walking skeleton first, then slices by added dimension — architecture first, content progressive', model: 'opus' },
    { title: 'Implement', detail: 'sequential slices, test-first: sonnet on low-risk slices with a contract, opus otherwise; a peer review per slice, escalation to opus on failure' },
    { title: 'Review', detail: 'adversarial review of the full diff, a red team on high-risk slices, then fixes, then an independent recheck' },
  ],
}

const task = typeof args === 'string' ? args : args && args.task
const dir = (args && args.dir) || 'the current working directory'
const opts = typeof args === 'object' && args !== null ? args : {}
// Accept "true" — args survive a JSON round-trip and booleans arrive as strings.
const go = opts.go === true || opts.go === 'true'
// until: stop after this many slices (1 = one slice per run, read the diff, relaunch).
// Absent means run every slice. Never coerce a bad value to Infinity: until:0 asking
// for nothing must not silently implement everything.
let until = Infinity
if (opts.until != null && opts.until !== '') {
  const n = Number(opts.until)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`big-feature: until must be a positive integer, got ${JSON.stringify(opts.until)}`)
  }
  until = n
}
if (!task) throw new Error('big-feature needs a task: args = {task: "...", dir: "/abs/path"}')

// slices: an approved plan handed back in a later session. resumeFromRunId is
// same-session only, so without this a fresh session must re-plan — and a re-plan
// is a NEW plan, not the one that was approved.
// gpt: add a blind second opinion on the design from GPT via the codex CLI.
const useGpt = opts.gpt === true || opts.gpt === 'true'
// fable: escalation for novel or large multi-agent work — plans on fable, seats it
// on the council. Opus 5.5 matches it on most tasks at 2.5x less per token.
const escalate = opts.fable === true || opts.fable === 'true'
// Fable seats only on explicit escalation: same family as Opus, so its errors are
// likely correlated, at 2.5x the price. Without GPT the council is Opus alone.
const useFable = escalate
const givenSlices = Array.isArray(opts.slices) ? opts.slices : null
if (givenSlices) {
  if (!givenSlices.length) throw new Error('big-feature: args.slices is empty')
  const bad = givenSlices
    .map((s, i) => (s && s.title && s.verification ? null : `slice ${i + 1}`))
    .filter(Boolean)
  if (bad.length) {
    throw new Error(`big-feature: each given slice needs at least title and verification — missing on ${bad.join(', ')}`)
  }
  if (!go) throw new Error('big-feature: args.slices is an approved plan — pass go:true to execute it, or drop slices to re-plan')
}

const NOTES = {
  type: 'object',
  properties: { notes: { type: 'string' } },
  required: ['notes'],
}

// An approved plan already encodes everything Explore and Vet would establish.
// Re-deriving it would also re-plan it, which is the one thing a carried plan exists
// to prevent. Slice prompts still name their own files, so implementers re-read the
// code themselves.
if (!givenSlices) phase('Explore')
const angles = givenSlices ? [] : [
  `Conventions & layout: in ${dir}, read the project CLAUDE.md if present, 2-3 representative source files, and the build/test config. Return: exact commands (build, test, single test, lint) INCLUDING their quiet/minimal-reporter form if the runner has one, naming and module conventions, test style.`,
  `Existing code: in ${dir}, find everything already related to this task: "${task}". Return: relevant files with one-line roles, existing helpers/types/utilities that MUST be reused, and anything that looks like a partial implementation. Explicitly list what must NOT be recreated.`,
  `Verification surface: in ${dir}, how are features like "${task}" tested today? Return: how to run one test in isolation, existing test utilities and fixtures to reuse, and a proposed executable acceptance check for this task (exact command + expected outcome).`,
]
const exploreResults = (await parallel(angles.map((p, i) => () =>
  agent(`${p}\nReturn dense factual notes only — no prose padding, no recommendations outside your angle.`,
    { label: `explore:${i + 1}`, phase: 'Explore', model: 'sonnet', schema: NOTES })
))).filter(Boolean)
const exploration = exploreResults.map(r => (r && r.notes) || '').filter(Boolean).join('\n\n---\n\n')
// Planning on an empty codebase read is worse than not planning: the model invents
// a plan grounded in nothing and every downstream phase inherits the fiction.
if (!givenSlices && !exploration) throw new Error('exploration produced nothing — aborting before planning blind')
if (!givenSlices && exploreResults.length < angles.length) {
  log(`explore: only ${exploreResults.length}/${angles.length} readers returned — plan rests on partial notes`)
}

const VET = {
  type: 'object',
  properties: {
    sourcesConsulted: {
      type: 'array',
      description: 'Every source you ACTUALLY opened this session: fetched URLs, Context7 library ids, registry pages, repo files as path:line. Training memory is not a source. An empty array declares that you verified nothing — it is recorded as UNVERIFIED in the result.',
      items: { type: 'string' },
    },
    findings: {
      type: 'array',
      description: 'empty when there is nothing worth flagging — that is a valid answer, provided sourcesConsulted is not also empty',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'one sentence, no preamble' },
          evidence: { type: 'string', description: 'which of sourcesConsulted backs this claim — a URL you fetched or file:line you read' },
          impact: { type: 'string', enum: ['blocks-plan', 'shapes-plan', 'fyi'] },
        },
        required: ['claim', 'evidence', 'impact'],
      },
    },
  },
  required: ['sourcesConsulted', 'findings'],
}
// One question, asked to two model families in parallel. Identical wording is the
// point: if they are asked different things, divergence tells you nothing.
const DESIGN_QUESTION =
  `Task in ${dir}: ${task}\n\nCodebase notes:\n${exploration}\n\n` +
  `Challenge this task's implied approach. Find the strongest case against it: failure modes with a ` +
  `concrete trigger, hidden migration cost, an invariant in the existing code it would break, ` +
  `prior art of people who tried this and regretted it. Search for current practice and for ` +
  `post-mortems — what was state of the art two years ago may be superseded. ` +
  `Report only what would change the plan. If the approach is sound, return no findings.`

const VET_EVIDENCE_RULE =
  `\n\nEVIDENCE IS MANDATORY. Consult live sources before answering — your training data is ` +
  `stale by construction and does not count. List every source you actually opened in ` +
  `sourcesConsulted. Returning findings you did not verify, or citing a source you did not ` +
  `open, is the one unacceptable outcome here. "I verified and found nothing" and ` +
  `"I verified nothing" are different answers: the first has sources, the second is recorded ` +
  `as UNVERIFIED and tells the planner not to trust this dimension.`

if (!givenSlices) phase('Vet')
// Must mirror the thunk order below: parallel() returns results positionally, and a
// dead agent yields null, so labels cannot be recovered from the results themselves.
const councilLabels = ['vet:deps', ...(useFable ? ['council:fable'] : []), 'council:opus', ...(useGpt ? ['council:gpt'] : [])]
// Round 2 must go back to the reasoner that MISSED a concern. Without this map the
// rebuttal spawns a default agent, and when the raiser is opus the same model is
// asked to confirm its own concern — self-agreement reported as independent review.
const SEAT_MODEL = { 'council:fable': 'fable', 'council:opus': 'opus', 'council:gpt': 'sonnet' }
const vetRaw = givenSlices ? [] : (await parallel([
  () => agent(
    `Task in ${dir}: ${task}\n\nCodebase notes:\n${exploration}\n\n` +
    `Verify every library, version, and API this task depends on, against live documentation — ` +
    `Context7 FIRST (resolve the library id, then query one concept per call), then the registry ` +
    `for existence, last release date, and deprecation. Flag: APIs that do not exist as assumed, ` +
    `versions that moved, deprecated packages, and anything already in the project that should be ` +
    `reused instead of added. Report only what would change the plan.` + VET_EVIDENCE_RULE,
    { label: 'vet:deps', phase: 'Vet', model: 'opus', effort: 'high', schema: VET }),
  // COUNCIL: the same design question, answered blind by different reasoners.
  // Blind is the whole point — a member who has read another's answer is commenting,
  // not judging, and its agreement stops being evidence.
  ...(useFable ? [() => agent(
    DESIGN_QUESTION + VET_EVIDENCE_RULE,
    { label: 'council:fable', phase: 'Vet', model: 'fable', effort: 'xhigh', schema: VET })] : []),
  () => agent(
    DESIGN_QUESTION + VET_EVIDENCE_RULE,
    { label: 'council:opus', phase: 'Vet', model: 'opus', effort: 'high', schema: VET }),
  // A different model family fails differently. That difference is what the seat buys.
  // Opt in with args.gpt — it costs a codex round-trip on the critical path.
  ...(useGpt ? [() => agent(
    `Ask GPT this question through the codex CLI, then report what it said.\n\n` +
    `Run it from ${dir} so GPT can read the code itself:\n` +
    `  codex exec -s read-only -m gpt-5.6-luna - <<'PROMPT'\n  <the question below>\n  PROMPT\n\n` +
    `The -m flag is required: without it codex uses its configured default, which may ` +
    `be a Claude-family model — and then this seat is not a second family at all.\n` +
    `--- question to relay verbatim ---\n${DESIGN_QUESTION}\n--- end ---\n\n` +
    `Report GPT's position in ITS terms, not yours. Put each concern it raised in ` +
    `findings, with evidence naming what GPT cited. In sourcesConsulted, list what ` +
    `GPT actually consulted plus "codex:gpt". If codex fails, return empty findings ` +
    `and empty sourcesConsulted — never substitute your own opinion for GPT's.`,
    { label: 'council:gpt', phase: 'Vet', model: 'sonnet', effort: 'medium', schema: VET })] : []),
]))

// Zip labels to results BEFORE dropping nulls. parallel() returns positionally with a
// null where an agent died; filtering first shifts every later result up one slot, so
// a dead vet:deps would silently rename fable's answer to vet:deps and opus's to fable.
const vetLabelled = vetRaw.map((r, i) => ({ seat: councilLabels[i] || `seat:${i}`, r }))
const vetResults = vetRaw.filter(Boolean)

const vetting = vetResults.flatMap(r => (r && r.findings) || [])
const vetSources = vetResults.flatMap(r => (r && r.sourcesConsulted) || [])
// An agent that consulted nothing and an agent that found nothing return the same
// empty findings array. Only sourcesConsulted separates them — surface it loudly.
// A carried plan skipped Vet by design; that is not the same as an unverified one.
const unverified = !givenSlices &&
  (vetResults.length < 2 || vetResults.some(r => !((r && r.sourcesConsulted) || []).length))

const blocking = vetting.filter(f => f.impact === 'blocks-plan')
const shaping = vetting.filter(f => f.impact === 'shapes-plan')
if (!givenSlices) {
  log(`vet: ${blocking.length} blocking, ${shaping.length} shaping, ${vetSources.length} source(s) consulted`)
  if (unverified) log('vet: WARNING — a vetting agent returned no sources; treat its dimension as UNVERIFIED')
}

// Counting findings cannot tell "both raised the same risk" from "both raised
// different risks" — only reading them can. A synthesiser compares the seats by
// content. It is explicitly forbidden to average: a concern one seat raised and the
// others missed is the most valuable output a council produces, and a consensus
// verdict is exactly how that gets destroyed.
const councilSeats = vetLabelled.filter(x => x.seat.startsWith('council:'))
const seatsThatRan = councilSeats.filter(x => x.r && (x.r.sourcesConsulted || []).length)

let contested = []
let councilVerdict = null
if (!givenSlices && seatsThatRan.length >= 2) {
  const transcript = councilSeats.map(({ seat, r }) => {
    const ran = r && (r.sourcesConsulted || []).length
    if (!ran) return `### ${seat}\nDID NOT RUN — no sources. Silence here is absence, not agreement.`
    const fs_ = (r.findings || [])
    return `### ${seat}\n` + (fs_.length
      ? fs_.map(f => `- [${f.impact}] ${f.claim} (evidence: ${f.evidence})`).join('\n')
      : 'Found nothing against the approach, having consulted sources.')
  }).join('\n\n')

  councilVerdict = await agent(
    `${councilSeats.length} reasoners answered the SAME design question independently, none ` +
    `seeing the others. Here is what each returned.\n\n${transcript}\n\n` +
    `--- the question they were asked ---\n${DESIGN_QUESTION}\n--- end ---\n\n` +
    `Compare them BY CONTENT, not by count. Two seats raising different risks is not ` +
    `agreement. Two seats phrasing one risk differently is not disagreement.\n\n` +
    `For each distinct concern across all seats, decide: which seats raised it, and ` +
    `which seats had the chance to raise it and did not.\n\n` +
    `RULES:\n` +
    `- Do NOT average, reconcile, or produce a consensus position. You are a comparator.\n` +
    `- A concern raised by ONE seat and missed by the others is the council's most ` +
    `valuable output. Never drop it for lack of support — that is the blind spot you ` +
    `were convened to find. Mark it contested and keep it whole, in the raiser's terms.\n` +
    `- Do not invent a concern no seat raised. You have no independent opinion here.\n` +
    `- If every seat found nothing, say so. That is a real result, not an empty one.`,
    { label: 'council:synth', phase: 'Vet', model: 'opus', effort: 'high',
      schema: {
        type: 'object',
        properties: {
          concerns: {
            type: 'array',
            description: 'one entry per DISTINCT concern across all seats; empty when every seat found nothing',
            items: {
              type: 'object',
              properties: {
                claim: { type: 'string', description: "the concern in the raising seat's own terms, not softened" },
                evidence: { type: 'string' },
                impact: { type: 'string', enum: ['blocks-plan', 'shapes-plan', 'fyi'] },
                raisedBy: { type: 'array', items: { type: 'string' }, description: 'seat labels that raised it' },
                missedBy: { type: 'array', items: { type: 'string' }, description: 'seats that ran and did not raise it' },
              },
              required: ['claim', 'evidence', 'impact', 'raisedBy', 'missedBy'],
            },
          },
        },
        required: ['concerns'],
      } })

  const concerns = (councilVerdict && councilVerdict.concerns) || []
  // Unanimous among seats that actually ran = corroborated. Anything less is contested:
  // a real signal one reasoner saw and another did not.
  contested = concerns
    .filter(c => (c.missedBy || []).length > 0)
    .map(c => ({ ...c, disputedBy: (c.missedBy || []).join(', ') }))
  const agreed = concerns.length - contested.length
  log(`council: ${seatsThatRan.length}/${councilSeats.length} seats ran — ` +
      `${concerns.length} distinct concern(s), ${agreed} corroborated, ${contested.length} contested`)
  if (seatsThatRan.length < councilSeats.length) {
    log('council: a seat produced nothing — its silence is absence of evidence, not agreement')
  }

  // ROUND 2, targeted. Round 1 leaves silence ambiguous: a seat that did not raise a
  // concern might disagree, or might simply not have thought of it. Those are very
  // different, and only asking resolves it. Deliberately NOT deliberation — a seat
  // sees one concern, not the others' full positions, so it re-reasons rather than
  // defers to the last argument it read.
  // One rebuttal per (concern, seat that missed it) — routed to that seat's model.
  // Asking a default agent instead would let the raiser's own model confirm itself.
  const rebuttalJobs = contested.flatMap(c =>
    (c.missedBy || [])
      .filter(seat => SEAT_MODEL[seat] && !(c.raisedBy || []).includes(seat))
      .map(seat => ({ concern: c, seat })))

  if (rebuttalJobs.length) {
    const rebuttals = (await parallel(rebuttalJobs.map(({ concern: c, seat }) => () => agent(
      `You reviewed this task independently and did not raise the concern below. Another ` +
      `reasoner did. Decide whether it is real — you are not being asked to agree.\n\n` +
      `--- the concern ---\n[${c.impact}] ${c.claim}\nEvidence offered: ${c.evidence}\n--- end ---\n\n` +
      `Context:\nTask in ${dir}: ${task}\n\nCodebase notes:\n${exploration}\n\n` +
      `Check it against the actual code and live sources. Then answer: does it hold?\n` +
      `- "real" — it holds, you missed it. Say what you missed.\n` +
      `- "refuted" — it does not hold. Say what makes it wrong, citing code or a source.\n` +
      `- "unresolved" — it cannot be settled without information neither of you has. Say what is missing.\n\n` +
      `Refuting is as valuable as conceding. Do not agree out of deference, and do not ` +
      `dig in to save face — the caller needs the truth about this one claim.` +
      (seat === 'council:gpt'
        ? `\n\nRelay this to GPT and report ITS verdict, not yours:\n` +
          `  codex exec -s read-only -m gpt-5.6-luna - <<'PROMPT'\n  <the question above>\n  PROMPT\n` +
          `If codex fails, return verdict "unresolved" and say codex failed.`
        : ''),
      { label: `rebut:${seat.replace('council:', '')}:${c.claim.slice(0, 18)}`, phase: 'Vet',
        model: SEAT_MODEL[seat], effort: seat === 'council:gpt' ? 'medium' : 'high',
        schema: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['real', 'refuted', 'unresolved'] },
            reasoning: { type: 'string', description: 'one or two sentences, citing code or a source' },
          },
          required: ['verdict', 'reasoning'],
        } }).then(v => ({ claim: c.claim, seat, verdict: v && v.verdict, reasoning: v && v.reasoning })))))
      .filter(Boolean)

    // Several seats may have missed one concern. Refuted by any of them beats upheld:
    // one reasoner finding it wrong on inspection outweighs another finding it right.
    const byClaim = new Map()
    for (const r of rebuttals.filter(r => r.verdict)) {
      const prev = byClaim.get(r.claim)
      if (!prev || (prev.verdict !== 'refuted' && r.verdict === 'refuted')) byClaim.set(r.claim, r)
    }
    // A refuted concern stays visible — one reasoner still saw it — but stops
    // constraining the plan as though it were established.
    contested = contested.map(c => {
      const r = byClaim.get(c.claim)
      return r ? { ...c, round2: r.verdict, round2Reasoning: r.reasoning, round2By: r.seat } : c
    })
    const tally = v => contested.filter(c => c.round2 === v).length
    log(`council round 2: ${tally('real')} upheld, ${tally('refuted')} refuted, ${tally('unresolved')} unresolved`)
  }
} else if (!givenSlices) {
  log(`council: only ${seatsThatRan.length} seat(s) ran — no cross-check possible`)
}

// Prefer the council's de-duplicated concerns over the raw union: three seats
// raising one risk should reach the planner once, not three times. Fall back to raw
// findings when no council ran (single seat, or a carried plan).
const councilConcerns = (councilVerdict && councilVerdict.concerns) || null
const planConstraints = councilConcerns
  ? [...councilConcerns.filter(c => c.impact === 'blocks-plan'),
     ...councilConcerns.filter(c => c.impact === 'shapes-plan')]
  : [...blocking, ...shaping]

// contested holds the annotated copies; planConstraints holds the originals. Look up
// by claim so the line can name both who raised a concern and who missed it.
const contestedByClaim = new Map(contested.map(f => [f.claim, f]))
// A council concern read without its round-2 verdict looks like it still stands.
const withVerdict = c => {
  const r = contestedByClaim.get(c.claim)
  return r && r.round2 ? { ...c, round2: r.round2, round2By: r.round2By, round2Reasoning: r.round2Reasoning } : c
}
const constraintLine = f => {
  const c = contestedByClaim.get(f.claim)
  let tag = ''
  if (c) {
    const raised = (c.raisedBy || []).join(', ') || 'one seat'
    const missed = c.disputedBy || (c.missedBy || []).join(', ') || 'another seat'
    // Name the seat that actually answered round 2, never the whole missedBy list —
    // attributing a verdict to a seat that was not asked is a fabricated citation.
    const answered = c.round2By || missed
    if (c.round2 === 'refuted') {
      tag = ` [REFUTED on review by ${answered}: ${c.round2Reasoning} — do not plan around this unless you disagree with the refutation]`
    } else if (c.round2 === 'real') {
      tag = ` [CONTESTED then UPHELD — ${answered} missed it in round 1 and confirms it on review: ${c.round2Reasoning}]`
    } else if (c.round2 === 'unresolved') {
      tag = ` [UNRESOLVED — ${raised} raised it, ${answered} could not settle it: ${c.round2Reasoning}]`
    } else {
      tag = ` [CONTESTED — raised by ${raised}, missed by ${missed}]`
    }
  }
  return `- [${f.impact}]${tag} ${f.claim} (${f.evidence})`
}

const constraints = (planConstraints.length
  ? `Constraints established by verification — the plan MUST respect these:\n` +
    planConstraints.map(constraintLine).join('\n') +
    (contested.length
      ? `\nItems above carry a review tag. Reasoners answered independently, then any concern ` +
        `one raised and another missed was put back to the one who missed it.\n` +
        `- UPHELD: treat as established.\n` +
        `- REFUTED: the reviewer checked and found it does not hold. Do not plan around it, ` +
        `unless the refutation is itself wrong — say so if you think it is.\n` +
        `- UNRESOLVED: nobody could settle it. Plan for it where that is cheap, and say in ` +
        `that slice's approach that it rests on an unresolved premise.`
      : '')
  : 'Verification flagged nothing to constrain the plan.')
  + (unverified
    ? `\nWARNING: a vetting dimension returned no sources and is UNVERIFIED. Do not treat ` +
      `silence there as confirmation — where a slice rests on an unchecked library or API, ` +
      `say so in its approach.`
    : `\nVerification consulted ${vetSources.length} source(s).`)

// PRE-FLIGHT, before planning. Every downstream claim is phrased as "verification
// passed", which means nothing without a baseline. Running it here — not before
// Implement — means the planner knows whether the suite is already red: told
// "bun test exits 0" on a red repo, an implementer's shortest path to that criterion
// is to "fix" the failing test nobody asked it to touch.
if (!givenSlices) phase('Plan')
const preflight = givenSlices ? null : await agent(
  `In ${dir}, record the starting state. Do not modify anything.\n` +
  `1. Is the working tree clean? Run git status --porcelain and report it verbatim (empty means clean).\n` +
  `2. Run the project's full test command once and report the exact command and its exit code.\n` +
  `Report what you find. A dirty tree or a red baseline is not your problem to fix — record it.`,
  { label: 'preflight', phase: 'Plan', model: 'sonnet', effort: 'low',
    schema: {
      type: 'object',
      properties: {
        treeClean: { type: 'boolean' },
        dirtyFiles: { type: 'array', items: { type: 'string' }, description: 'porcelain lines; empty when clean' },
        testCommand: { type: 'string', description: 'exact command run, or "none" if the project has no test command' },
        testExitCode: { type: 'number', description: '0 = green baseline; -1 when no test command exists' },
        failingTests: { type: 'array', items: { type: 'string' }, description: 'names of already-failing tests; empty when green' },
      },
      required: ['treeClean', 'dirtyFiles', 'testCommand', 'testExitCode', 'failingTests'],
    } })

const baseline = preflight
  ? { clean: preflight.treeClean, dirty: preflight.dirtyFiles || [], cmd: preflight.testCommand,
      exit: preflight.testExitCode, failing: preflight.failingTests || [] }
  : { clean: null, dirty: [], cmd: 'unknown', exit: null, failing: [] }
if (!givenSlices && !preflight) {
  log('preflight: agent lost — baseline unknown, every verification claim below is unanchored')
} else if (!givenSlices) {
  log(`preflight: tree ${baseline.clean ? 'clean' : `DIRTY (${baseline.dirty.length} file(s))`}, ` +
      `baseline ${baseline.exit === 0 ? 'green' : baseline.exit === -1 ? 'no test command' : `RED (exit ${baseline.exit})`}`)
  if (!baseline.clean) log('preflight: uncommitted work present — the final diff will mix it with this run')
  if (baseline.exit > 0) log('preflight: tests already failing — a slice "passing" proves less than it appears')
}

const BASELINE_FOR_PLANNER = baseline.exit === null
  ? `\nBASELINE UNKNOWN: the pre-flight check failed. Do not assume the suite is green.\n`
  : `\nSTARTING STATE (measured, not assumed):\n` +
    `- Working tree: ${baseline.clean ? 'clean' : `DIRTY — ${baseline.dirty.join(', ')}. That work predates this task; no slice may touch or claim it.`}\n` +
    `- Test command: ${baseline.cmd}, exit ${baseline.exit}` +
    (baseline.exit > 0
      ? ` (ALREADY FAILING${baseline.failing.length ? `: ${baseline.failing.join('; ')}` : ''}).\n` +
        `  Never write an acceptance criterion of the form "the full suite exits 0" — it is unreachable, ` +
        `and an implementer chasing it will "fix" the pre-existing failure instead. Scope every criterion ` +
        `to the slice's own tests, and state the expected whole-suite failure count as unchanged.\n`
      : `.\n`)

const PLAN = {
  type: 'object',
  properties: {
    slices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          structure: {
            type: 'string',
            description: 'module boundary or data structure this slice establishes or generalizes; "none" for a behavior fill-in slice',
          },
          structureJustification: {
            type: 'string',
            description: 'the test IN THIS SLICE that fails if the structure is deleted; "none" when structure is "none". Not a later slice — a later slice means speculative, cut it.',
          },
          approach: { type: 'string' },
          contract: {
            type: 'string',
            description: 'every design decision the implementer must not take alone: exact signatures and types, where each piece lives, invariants, edge cases and their expected behaviour',
          },
          risk: {
            type: 'string',
            enum: ['low', 'high'],
            description: 'high when a bug here corrupts state, breaks a core invariant, touches persistence, security, concurrency or determinism, or the contract cannot pin the design',
          },
          verification: {
            type: 'string',
            description: 'exact command + expected outcome, run-able today. Must be able to fail against a plausibly-wrong implementation — "it compiles" is not verification.',
          },
        },
        required: ['title', 'files', 'structure', 'structureJustification', 'approach', 'contract', 'risk', 'verification'],
      },
    },
  },
  required: ['slices'],
}
const plan = givenSlices ? { slices: givenSlices } : await agent(
  `Design an implementation plan for this task in ${dir}:\n\n${task}\n\n` +
  `Exploration notes from the codebase:\n${exploration}\n\n` +
  `${constraints}\n${BASELINE_FOR_PLANNER}\n` +
  `BIAS: architecture first, content progressive. Real module boundaries, real ` +
  `signatures and real data structures land early and stay; behavior fills in ` +
  `progressively. Do NOT enumerate use cases. A plan that is a list of scenarios ` +
  `is the failure mode this instruction exists to prevent.\n\n` +

  `Rules:\n` +
  `1. 2-6 slices, ~150 lines of diff max each. Every slice touches data + behavior + ` +
  `test and runs end to end through the real boundaries. Never a horizontal layer ` +
  `("all the types", "the whole data layer"): a slice that cannot be exercised is not a slice.\n` +
  `2. Slice 1 is a WALKING SKELETON (Cockburn) / TRACER BULLET (Hunt & Thomas): the ` +
  `real module boundaries and the real core data structures, connected end to end, ` +
  `carrying exactly ONE thin case that proves the path. Thin but complete — production ` +
  `quality, kept, not a prototype. Internals below the boundary may be a named stub; ` +
  `name it in the approach and name the slice that replaces it.\n` +
  `3. Slices 2+ are defined by an ADDED DIMENSION, not by a scenario. Good axes: 1 -> N ` +
  `of something, deterministic replay from a seed, persist and reload, a second real ` +
  `implementer of an existing boundary, an error/edge dimension the skeleton assumed away. ` +
  `Each dimension must force the data structures to generalize AND fail a concrete test ` +
  `before it is implemented.\n` +
  `4. Every slice needs an executable verification: exact command + expected outcome, ` +
  `run-able today in this repo, not aspirational. "It compiles" and "types check" are ` +
  `NOT verification. A slice whose test cannot fail against a plausibly-wrong ` +
  `implementation is not verified — reshape it or say you do not understand it. ` +
  `Do not pad.\n` +
  `5. Where the value is structural, prefer verification that pins structure rather ` +
  `than scenarios: round-trip (encode -> decode preserves the model), invariants that ` +
  `hold over generated input, idempotence, replay determinism, or a contract exercised ` +
  `by two real implementers. Use these only when the check actually fails against a ` +
  `wrong data model — a property test that only exercises its own generator is padding.\n` +
  `6. EVOLUTIVE, NOT SPECULATIVE. Test each piece of structure you plan: would a test ` +
  `IN THAT SAME SLICE fail if you deleted it? If the only thing that would break is a ` +
  `later slice, cut it. Hard limits: no interface or abstraction with one implementer, ` +
  `no field, parameter, config knob or enum case unread by code shipped in its own ` +
  `slice, no generality whose second use is hypothetical rather than named in a later ` +
  `slice of THIS plan. Extension points are earned by a named second consumer, ` +
  `never anticipated.\n` +
  `7. Reuse everything the notes say already exists. Recreate nothing.\n` +
  `8. Every slice carries a "contract" that settles its design: an implementer who ` +
  `follows it takes no design decision of its own. Mark "risk" high when a bug in the ` +
  `slice would corrupt state or break a core invariant, or when you cannot pin its ` +
  `design in the contract. High-risk slices get the strong implementer and a red team.\n\n` +

  `For each slice state, in "structure", what module boundary or data structure it ` +
  `establishes or generalizes, and in "structureJustification" the same-slice test that ` +
  `fails without it. If a slice establishes no structure, say "none" — that is valid ` +
  `for a behavior fill-in slice.\n\n` +

  `Before returning, grill your own plan as a staff engineer: strike any slice that is ` +
  `just a use case, any structure that fails the deletion test in rule 6, and any ` +
  `verification that would pass against an empty implementation. Fix what breaks.`,
  { label: 'plan', phase: 'Plan', model: escalate ? 'fable' : 'opus', effort: 'xhigh', schema: PLAN })

// One dead planner must not destroy a run that already paid for Explore and Vet.
if (!plan || !Array.isArray(plan.slices)) throw new Error('planning failed — relaunch to retry')
if (!plan.slices.length) throw new Error('planner returned no slices — the task is unclear or already done')

log(givenSlices
  ? `${plan.slices.length} slices carried in — explore, vet and plan skipped`
  : `${plan.slices.length} slices planned`)

// Everything upstream — explore, vet, council, round 2 — converges on ONE planner
// call that nothing reads back. Every other artifact here gets an adversarial pass;
// the highest-leverage one got none, and a plan that quietly drops a blocks-plan
// constraint wastes all of it. Audit the plan, not the code, before the checkpoint.
let planAudit = null
if (!givenSlices && planConstraints.length) {
  planAudit = await agent(
    `Audit this plan against the constraints verification established. You are not ` +
    `redesigning it — you are checking whether it honours what was already proven.\n\n` +
    `--- constraints (each was verified, and contested ones survived a second round) ---\n` +
    planConstraints.map(constraintLine).join('\n') + `\n--- end ---\n\n` +
    `--- the plan ---\n` +
    plan.slices.map((s, i) =>
      `Slice ${i + 1}: ${s.title}\nFiles: ${(s.files || []).join(', ')}\n` +
      `Structure: ${s.structure}\nApproach: ${s.approach}\nVerification: ${s.verification}`
    ).join('\n\n') + `\n--- end ---\n\n` +
    `For each constraint, decide: honoured by a named slice, contradicted by one, or ` +
    `silently dropped. Dropped is the failure mode that matters — a REFUTED constraint ` +
    `is correctly ignored, but a blocks-plan one that appears nowhere means the plan ` +
    `discarded verified work.\n` +
    `Also check each slice's verification could actually fail against a wrong ` +
    `implementation. "The suite passes" against an already-red baseline is not a criterion.\n` +
    `Report only real gaps. A plan that honours everything is the expected result — say so and stop.`,
    { label: 'plan:audit', phase: 'Plan', model: 'opus', effort: 'high',
      schema: {
        type: 'object',
        properties: {
          gaps: {
            type: 'array',
            description: 'empty when the plan honours every constraint — that is the expected outcome, not a thin answer',
            items: {
              type: 'object',
              properties: {
                constraint: { type: 'string', description: 'the constraint, quoted' },
                state: { type: 'string', enum: ['dropped', 'contradicted', 'weak-verification'] },
                detail: { type: 'string', description: 'which slice, and what is missing' },
              },
              required: ['constraint', 'state', 'detail'],
            },
          },
        },
        required: ['gaps'],
      } })
  const gaps = (planAudit && planAudit.gaps) || []
  log(gaps.length
    ? `plan audit: ${gaps.length} gap(s) — ${gaps.map(g => g.state).join(', ')}`
    : `plan audit: all ${planConstraints.length} constraint(s) honoured`)
}

if (!go) {
  log('PLAN ONLY — review the slices, then relaunch with go:true to execute')
  return {
    mode: 'plan',
    slices: plan.slices,
    vetting: vetting.length ? vetting : 'nothing flagged',
    vetSources: unverified ? `INCOMPLETE — ${vetSources.length} source(s), a dimension went unverified` : vetSources,
    // Carry the round-2 verdicts into `council` too: read on its own it otherwise
    // shows a refuted concern as though it still stood.
    council: councilConcerns ? councilConcerns.map(withVerdict) : undefined,
    contested: contested.length ? contested : undefined,
    baseline,
    planAudit: (planAudit && planAudit.gaps && planAudit.gaps.length) ? planAudit.gaps : undefined,
    next: 'Same session: relaunch Workflow({scriptPath, resumeFromRunId: "<this runId>", args: {...args, go: true}}) — explore+vet+plan replay from cache. Fresh session: the cache is gone, so pass this exact slices array back as args.slices with go:true to execute THIS plan instead of generating a new one.',
  }
}

// PRE-FLIGHT. Every downstream claim is phrased as "verification passed", which means
// nothing without a baseline: a slice can pass against a suite that was already red,
// and the final diff can attribute pre-existing uncommitted work to this run.
phase('Implement')
const SLICE_RESULT = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    status: { type: 'string', enum: ['done', 'blocked'] },
    command: { type: 'string' },
    exitCode: { type: 'number' },
    output: {
      type: 'string',
      description: 'last ~15 lines of verification output — enough to see pass/fail and the first real error. Not the whole run; a green suite needs one summary line.',
    },
  },
  required: ['title', 'status', 'command', 'exitCode', 'output'],
}
const SLICE_REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'issues'],
}
const sliceBrief = (s, i) =>
  `In ${dir}, implement slice ${i + 1}/${plan.slices.length} of: ${task}\n\n` +
  `Slice: ${s.title}\nFiles: ${(s.files || []).join(', ')}\nApproach: ${s.approach}\n` +
  `Structure this slice establishes: ${s.structure || 'none'}\n` +
  `Contract: ${s.contract || 'none given — follow the approach and the codebase conventions'}\n` +
  `Already completed: ${done.map(d => d.title).join('; ') || 'nothing yet'}\n\n` +
  `The contract is the design. Take no design decision it does not settle: if the slice ` +
  `needs one, return status "blocked" and name the decision in the output.\n` +
  `Method: write the failing test FIRST, then the minimal code that passes it. ` +
  `Reuse existing helpers — recreate nothing. Match local conventions exactly. ` +
  `No dead code, no commented-out blocks, no comments narrating the diff. ` +
  `Build exactly the structure named above — no interface with one implementer, ` +
  `no field or parameter unread by code in this slice, no extension point whose ` +
  `second consumer is hypothetical. Structure beyond what this slice's test exercises ` +
  `is speculative: leave it out.\n` +
  `Then run: ${s.verification}\n` +
  `Prefer the project's quiet reporter when it has one (--reporter=dot, -q, --silent) ` +
  `and scope the run to the tests this slice touches — a full verbose suite buries the ` +
  `one line that matters.\n` +
  `Return the verification command, its exit code, and the last lines of output. ` +
  `If verification still fails after 3 attempts, return status "blocked" with the real error — never fake success.`
const reviewSlice = (s, i, attempt) => agent(
  `In ${dir}, review slice ${i + 1} ("${s.title}") of: ${task}\n` +
  `Read the uncommitted changes to these files: ${(s.files || []).join(', ')}.\n` +
  `Contract the slice had to honour:\n${s.contract || s.approach}\n` +
  `Fail the slice only for: a contract point not honoured, a design decision taken that the ` +
  `contract did not settle, a test that would pass against a plausibly-wrong implementation, ` +
  `or code outside the slice's files. Verify each issue against the code. Style nits are not issues.`,
  // The attempt in the label keeps a resumed run from replaying the first verdict.
  { label: `peer:${(s.title || `slice ${i + 1}`).slice(0, 30)}:${attempt}`, phase: 'Implement',
    model: 'sonnet', effort: 'medium', schema: SLICE_REVIEW })

const done = []
for (const [i, s] of plan.slices.entries()) {
  // Sonnet only implements what a contract has already designed; anything else stays on opus.
  // Slices from plans approved before contract/risk existed carry neither, and stay on opus.
  const cheap = s.risk === 'low' && Boolean(s.contract)
  const label = `slice:${(s.title || `slice ${i + 1}`).slice(0, 30)}`
  let model = cheap ? 'sonnet' : 'opus'
  let r = await agent(sliceBrief(s, i),
    { label, phase: 'Implement', model, effort: 'high', schema: SLICE_RESULT })
  if (r && r.status === 'done') {
    let peer = await reviewSlice(s, i, 1)
    if (peer && peer.verdict === 'fail') {
      log(`slice ${i + 1} failed peer review (${peer.issues.length} issue(s)) — escalating to opus`)
      model = 'opus'
      r = await agent(
        `${sliceBrief(s, i)}\n\nA previous attempt is already in the working tree. ` +
        `A peer review rejected it for:\n${peer.issues.map(x => `- ${x}`).join('\n')}\n` +
        `Fix these issues in place, then re-run the verification.`,
        { label: `${label}:retry`, phase: 'Implement', model: 'opus', effort: 'high', schema: SLICE_RESULT })
      peer = r && r.status === 'done' ? await reviewSlice(s, i, 2) : peer
      if (r && r.status === 'done' && peer && peer.verdict === 'fail') {
        r = { ...r, status: 'blocked', output: `peer review still failing: ${peer.issues.join('; ')}` }
      }
    }
  }
  if (!r || r.status === 'blocked') {
    done.push(r || { title: s.title, status: 'blocked', command: '', exitCode: -1, output: 'agent lost' })
    log(`slice ${i + 1} blocked — stopping before building on a broken base`)
    break
  }
  done.push(r)
  log(`slice ${i + 1}/${plan.slices.length} done (${model}): ${s.title}`)
  if (done.length >= until && i + 1 < plan.slices.length) {
    log(`stopping after ${done.length} slice(s) — read the diff, then relaunch to continue`)
    break
  }
}

// A blocked run is not a finished one. Without this split it reported mode 'executed'
// with remaining [] — claiming the feature shipped while slices were never attempted.
const blocked = done.some(d => !d || d.status !== 'done')
// A blocked slice sits in `done` but is not done: count it as unfinished alongside
// the slices the break never reached, or `remaining` reads empty on a failed run.
const completed = done.filter(d => d && d.status === 'done').length
const unfinished = plan.slices.slice(completed).map(s => s.title || 'untitled')
const partial = !blocked && unfinished.length > 0

phase('Review')
let review = null
let red = null
let recheck = null
// Review the whole diff, or a paused run's slices so far. Never a broken tree.
if (done.length && done.every(d => d.status === 'done')) {
  review = await agent(
    `In ${dir}, adversarially review the uncommitted changes (git diff + untracked files) implementing: ${task}.\n` +
    (baseline.clean === false
      ? `NOTE: the tree was ALREADY DIRTY before this run — ${baseline.dirty.slice(0, 10).join(', ')}. ` +
        `Those changes are not this run's work. Do not review or attribute them.\n`
      : '') +
    (baseline.exit > 0
      ? `NOTE: the test suite was ALREADY FAILING before this run (${baseline.cmd} exited ${baseline.exit}). ` +
        `A passing slice does not clear pre-existing failures.\n`
      : '') +
    `Hunt for: correctness bugs, AI slop (dead code, needless abstractions, reimplementations of existing helpers, ` +
    `over-commenting), convention mismatches, missing or weak tests. ` +
    `Apply the deletion test to every abstraction in the diff: if no test in this diff fails when you ` +
    `delete it, it is speculative — flag it. Specifically: interfaces with one implementer, fields or ` +
    `parameters nothing reads, config knobs nothing sets, enum cases nothing matches on. ` +
    `Also flag the reverse: a hardcoded special case where the planned structure should have absorbed it.\n` +
    `The slices claimed to establish: ${plan.slices.map(s => s.structure).filter(x => x && x !== 'none').join('; ') || 'no structure'}. ` +
    `Check the diff actually built that, and nothing beyond it.\n` +
    `Verify each finding against the actual code before reporting it. A clean diff is a valid result — ` +
    `do not manufacture findings to justify the review.`,
    // Adversarial reading is the one place worth the strong model: a missed defect
    // here ships, and the fix loop below trusts this verdict.
    { label: 'review', phase: 'Review', model: 'opus', effort: 'high',
      schema: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                issue: { type: 'string' },
                severity: { type: 'string', enum: ['must-fix', 'nice'] },
              },
              required: ['file', 'issue', 'severity'],
            },
          },
        },
        required: ['findings'],
      } })
  // Red team only where a missed defect is expensive: the slices the planner marked high.
  const risky = plan.slices.slice(0, done.length).filter(s => s.risk !== 'low')
  red = risky.length ? await agent(
    `In ${dir}, you are the red team on the uncommitted changes implementing: ${task}.\n` +
    `Attack these high-risk slices:\n` +
    risky.map(s => `- ${s.title} (files: ${(s.files || []).join(', ')})\n  contract: ${s.contract || s.approach}`).join('\n') +
    `\nFind inputs, states or sequences that break the contract or a project invariant. ` +
    `For each finding, give the concrete scenario and, when you can, a test that fails today. ` +
    `Report only defects you confirmed against the code. No style findings. An empty list is a valid result.`,
    { label: 'red', phase: 'Review', model: 'opus', effort: 'high',
      schema: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: { file: { type: 'string' }, issue: { type: 'string' } },
              required: ['file', 'issue'],
            },
          },
        },
        required: ['findings'],
      } }) : null
  if (red) log(`red team: ${red.findings.length} finding(s) on ${risky.length} high-risk slice(s)`)
  const mustFix = ((review && review.findings) || []).filter(f => f.severity === 'must-fix')
    .concat(((red && red.findings) || []).map(f => ({ ...f, severity: 'must-fix' })))
  if (mustFix.length) {
    log(`${mustFix.length} must-fix findings — applying fixes`)
    await agent(
      `In ${dir}, fix these review findings with the smallest possible diff, then re-run the project's test command and report command + exit code + output tail:\n` +
      mustFix.map(f => `- ${f.file}: ${f.issue}`).join('\n'),
      // Findings arrive already diagnosed, and the recheck below verifies the result.
      { label: 'fix', phase: 'Review', model: 'sonnet', effort: 'high' })

    // The fixer grades its own work. Confirm against the tree before believing it.
    recheck = await agent(
      `In ${dir}, verify these findings were actually fixed in the working tree. For each one, ` +
      `read the current code and decide: fixed, still-open, or made-worse. ` +
      `Then run the project's test command and report its exit code.\n` +
      `Findings that were supposed to be fixed:\n` +
      mustFix.map(f => `- ${f.file}: ${f.issue}`).join('\n'),
      // Mechanical: read the tree, classify each finding, report an exit code.
      // Cheap model is enough, and its output is checked against the test run anyway.
      { label: 'recheck', phase: 'Review', model: 'sonnet', effort: 'low',
        schema: {
          type: 'object',
          properties: {
            outcomes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' },
                  state: { type: 'string', enum: ['fixed', 'still-open', 'made-worse'] },
                },
                required: ['file', 'state'],
              },
            },
            testExitCode: { type: 'number' },
          },
          required: ['outcomes', 'testExitCode'],
        } })
    const unresolved = ((recheck && recheck.outcomes) || []).filter(o => o.state !== 'fixed')
    const exit = recheck ? recheck.testExitCode : 'unknown (recheck agent lost)'
    log(unresolved.length
      ? `recheck: ${unresolved.length} finding(s) NOT resolved — tests exit ${exit}`
      : `recheck: all fixed, tests exit ${exit}`)
  }
}

return {
  mode: blocked ? 'blocked' : partial ? 'paused' : 'executed',
  slices: done,
  remaining: unfinished,
  baseline,
  vetting: vetting.length ? vetting : 'nothing flagged',
  vetSources: unverified ? `INCOMPLETE — ${vetSources.length} source(s), a dimension went unverified` : vetSources,
  review: (review && review.findings) || [],
  red: red ? red.findings : undefined,
  recheck,
  next: blocked
    ? `Slice ${completed + 1} blocked; ${Math.max(0, unfinished.length - 1)} further slice(s) never attempted. Read the failure, fix the brief or the code, then relaunch.`
    : partial
      ? `Read the diff. To continue, relaunch with args.until raised to ${done.length + 1} (or omit until to run the rest). Same runId replays finished slices from cache.`
      : undefined,
}
