# forge — design spec

Status: draft v2, 2026-09-28 — revised after three blind reviews (adversarial,
implementability, GPT). Replaces `big-feature.js` once verified.

## 1. Goal

One entry point for coding tasks of any size. Quality first, then cost, then speed.
Three failure classes it exists to prevent:

- **Unproven claims** — "tests pass", "bug found", "fixed" taken on an agent's word.
- **Wasted spend** — a fixed heavy pipeline, and prose debate between models.
- **State drift** — long runs that rely on a summary instead of disk and git.

## 2. Principles

1. **Proof over prose.** A claim counts only when an executed command backs it.
   Prose opinions go to a human, never to another model for a verdict.
2. **References, not rewrites.** An agent that sorts, groups, judges, or relays
   returns ids and closed verdicts (`enum`, `boolean`). The script copies any text
   it shows or forwards verbatim from its source.
3. **Disk is the source of truth.** Every fact carries the commit SHA it was proven
   at. Resuming reads disk; no summary is ever an input.
4. **Risk only rises.** Any phase may raise the run or slice risk; none may lower it.
   A human may dismiss one named risk signal, with a reason, logged.
5. **One writer.** Only the scribe writes to the run directory, and only sequentially.
6. **The spec is the contract.** Build, red team, judge, and review all bind to spec
   clause ids. Anything that cannot be traced to a clause is suspect.
7. **Hashes, not transcriptions.** A model's retelling of a file or an exit code is
   not proof. Writes are verified by sha256 computed in the script; commits by
   `git rev-parse`; runs by raw output tails logged verbatim.
8. **Every test is judged.** Builder tests and red tests alike pass the judge before
   they count. Failing at A and passing at B only proves a test beats a stub.

## 3. Invocation

```
Workflow({ name: 'forge', args: {
  task:    "…",                          // required on a new run
  dir:     "/abs/path/to/repo",          // default: cwd
  runId:   "2026-09-28-auth-expiry",     // required: scripts cannot read the clock
  resume:  ".claude/runs/<id>",          // continue a run, any session
  approve: { hash: "<plan hash shown>",  // pass a checkpoint; hash must match
             answers: { q1: "yes",       //   the plan the questions came from
                        q2: "no: 404, not 403" } },
  gpt:     false,                        // enable GPT seats/attackers via codex
  tier:    "S" | "M" | "L",              // force size (up or down, logged)
  dismiss: ["<signal id>: <reason>"],    // drop one risk signal, logged
  allowRed: false,                       // run on a red baseline
  until:   N                             // stop after N slices
}})
```

## 4. Architecture

`forge.js` is the orchestrator. Each phase is a **named saved workflow**, flat in
`~/.claude/workflows/`: `forge-triage`, `forge-plan`, `forge-build`, `forge-duel`,
`forge-close`. The orchestrator calls them with `workflow('forge-duel', args)`.

Why named, not `workflow({scriptPath})`: a script path must already be readable by
the session, which fails from any other repo without a new permission rule. Named
workflows need no permission change, and `forge-duel` runs standalone on any diff.

Nesting is one level deep, so phase workflows never call `workflow()`; only the
orchestrator composes. Phases exchange data through the orchestrator as JSON, and
through artifacts written by the scribe. This folder holds docs and fixtures only.

### Roles

| Role | Agent / model | Writes | Returns |
|---|---|---|---|
| scout | sonnet, medium | nothing | facts + risk signals with `file:line` |
| researcher | `researcher` agent, model overridden to opus | nothing | dependency/API findings with ids |
| seat | opus xhigh; gpt via codex `-s read-only` | nothing | concerns (bounded fields) |
| planner | opus (medium for S, xhigh for M/L) | nothing | slices + clauses |
| shadow planner | opus, high, high risk only | nothing | clauses for risky signals, written blind to the planner |
| comparator | sonnet, medium | nothing | `{planner_clause, shadow_clause, verdict}` ids only |
| clause critic | sonnet, medium | nothing | `{clause, verdict}` only |
| builder | `implementer` agent, opus high | code, tests, in the run worktree | clause→test map; SHAs come from the runner |
| red | sonnet or opus; gpt via codex `-s workspace-write` | new test files only, in its own worktree | test ids + clause ids |
| judge | dedicated `judge` agent, **no tools**, opus medium | nothing | `{test, verdict}` only |
| blue | `implementer` agent, opus high | code, in the run worktree | `{test, fixed \| reject, clause}` |
| reviewer | `reviewer` agent, opus high | nothing | findings, `file:line` + category |
| runner | sonnet, low, Bash | git worktrees, commits, test runs | `{sha, command, exit, tail, failing[], passing[]}` |
| scribe | haiku, low | run dir only | `shasum -a 256` of what it wrote |

The runner is also the git clerk: it creates and removes worktrees, installs
dependencies in them, and makes the commits no other role may make. Every SHA in
the run comes from its `git rev-parse` output, never from another agent's report.

The judge has no tools, so it sees only what the script puts in its prompt. Blindness
is enforced, not requested.

## 5. Flow

```
GLOBAL
  1 triage       run worktree + baseline + text risk     always
  2 understand   scout reads the repo                    always
  3 re-triage    code rule, zero tokens                  always
  4 deps         researcher                    if new dep / external API
  5 council      blind seats, grouped in code  M/L and high risk
  6 plan         slices + typed clauses                  always (light for S)
                 + shadow planner, compared by ids       high risk only
  7 re-triage    size and risk from plan.files, raise-only
  8 clause check critic flags bad clauses                always
    ── checkpoint: see the table in §6 ──
PER SLICE
  9 build        A tests fail, judge, B passes           runner verifies
 10 duel         red → runner → judge → blue             ≤ 2 rounds
    ── checkpoint: after each slice, if high risk ──
GLOBAL
 11 close        full suite, targeted review, report
 12 human        reads the diff, squash-merges           always
```

## 6. Triage (1–3)

**Run worktree.** The runner creates a dedicated worktree from HEAD:
`git worktree add <path> -b forge/<id>/main`, then installs dependencies there. The
whole run happens in it. The user's checkout stays untouched, so an uncommitted file
there can never leak into a test run.

**Baseline** (runner): test command, fast-suite command, typecheck and lint commands,
exit codes with raw tails, failing tests, suite duration. The scout adds text risk
signals. A red baseline stops the run unless `allowRed`; then failing tests are
recorded and excluded from every later signal.

**Protected files.** Triage records the harness files: test config, package scripts,
lockfiles, CI config, shared fixtures. Any later diff that touches one blocks the
slice and escalates to the human. Editing the harness is how a green run lies.

**Scout** (sonnet medium) reports facts, not verdicts: likely files and count,
reusable helpers, conventions, test surface, and code risk signals, each with
`file:line`:

| Signal id | Examples |
|---|---|
| `persistence` | schema, migration, DB write |
| `auth` | session, token, permission, secret |
| `money` | price, payment, billing |
| `concurrency` | lock, queue, shared write |
| `untrusted-input` | request body, user file parsing |
| `public-api` | export used elsewhere, breaking change |
| `data-loss` | delete, overwrite |

**Re-triage** is a rule in the script:

```
size  S  ≤ 2 files and no new module
      M  3–8 files
      L  > 8 files or a new subsystem
risk  high if any signal from text OR code, minus dismissed ones
```

| | Low risk | High risk |
|---|---|---|
| **S** | light plan, 1 slice, 1 sonnet attacker, no checkpoint | 1 slice, 2 attackers, checkpoint after plan |
| **M/L** | plan, 1 opus attacker, checkpoint after plan | council + plan, 2 attackers per slice, checkpoints after plan and after each slice |

This table is the only source for checkpoints; §5 refers to it.

**Second re-triage after the plan.** Size and risk are recomputed from `plan.files`,
raise-only. Trigger it guards: the scout estimated 2 files (S, no council), the plan
touches 7. A raise to M/L high risk runs the council, then re-plans once.

Before any expensive phase the script logs one line, e.g.
`M · high (persistence: src/db/schema.ts:42) · council + plan · checkpoint after plan`.

## 7. Council (5)

Runs for M/L at high risk. Seats answer one question blind: the strongest case
against the implied approach. Seats must consult live sources and list them, or
declare `UNVERIFIED`.

- `gpt: true` → opus xhigh + gpt, in parallel.
- `gpt: false` → one critical pass, opus xhigh. Same-family seats likely share errors.

Concern schema (lengths bounded): `claim ≤200`, `trigger ≤300`, `evidence`
(`file:line` or URL), `test ≤300 | null`. Free reasoning first, JSON last.

**Grouping** is code only: concerns that share a `file:line` range or a URL are
grouped. No agent groups — with one or two seats, an LLM grouper adds a failure path
for almost no gain. Display is built by the script, every `claim` verbatim.

**Routing.** No synthesis verdict, no rebuttal round.
- Testable concern → must become a clause (`source: council#N`) or be listed in
  `rejected` with a reason. Rejections are rendered verbatim at the checkpoint: a
  planner's rejection is a model verdict on prose, so a human sees it.
- Untestable concern → shown verbatim at the plan checkpoint; the human decides.

Each concern keeps its seat label, and the ledger records its outcome (confirmed red
test, stayed green, rejected by human). Reports do not show per-seat yield: on one
run it is noise. The ledger keeps the raw data for later cross-run statistics.

## 8. Plan (6–7)

Slice schema:

```
{ id, title, files[],
  spec: [{ id: "S2.1",
           kind: "behavior" | "negative" | "preserve"
               | "migration" | "concurrency" | "property",
           input, action, expected,
           source: "task" | "council#N" | "deps#N" }],
  acceptance: [{ clause, level: unit | integration | e2e }],
  structure,        // new structure + the clause that needs it
  depends_on[], notes (bounded) }
```

Clause kinds:

- `behavior` — new behavior; its test must fail at A and pass at B.
- `negative` — what must NOT happen (non-admin denied, bad input rejected).
- `preserve` — existing behavior that must survive; its test passes at base AND at
  B. It exists so refactors never push the builder toward a fake failing test.
- `migration` — schema change applies and rolls back.
- `concurrency` — holds under parallel execution (see §10 for its run rule).
- `property` — an invariant over generated inputs.

**Required kinds per risk signal.** Every slice whose run carries a signal must hold
at least one clause of the matching kind. The script checks it.

| Signal | Required clause kind |
|---|---|
| `auth` | `negative` |
| `persistence` | `migration` if the schema changes, else `negative` |
| `concurrency` | `concurrency` |
| `untrusted-input` | `property` or `negative` |
| `money`, `data-loss` | `negative` |
| `public-api` | `preserve` |

Trigger this guards: "only admins may export" planned as "admins can export", with
no clause for the non-admin. Every check passes and authorization is broken.

Vertical slices, walking skeleton first. The script checks mechanically:

- no empty clause field;
- every council and deps id appears in a clause `source` or in `rejected`;
- required kinds are present.

A failed check re-runs the planner once, then escalates to the human.

**Slice risk** starts at the run's risk. It can only rise, never fall below it. A
text-only signal such as `money` from the task has no `file:line`, and new logic can
land in a new file; overlap-based dosing would leak risk downward in both cases.
Only a human `dismiss` lowers a slice, one named signal at a time.

**Clause check** runs at every risk level. The critic returns `{clause, verdict:
ok | ambiguous | untestable | contradicts:<id>}`. Non-ok verdicts re-run the planner
once for those clauses, then escalate. Clauses still flagged are shown first at the
checkpoint.

**Checkpoint: questions, not a document.** Humans do not read plans; they answer
short closed questions. A checkpoint that says "approve this plan" is approved
unread, so it guards nothing. The checkpoint asks at most 5 one-line questions,
answerable by yes, no, or a correction.

At high risk, a **shadow planner** writes clauses for the risky signals only, from
the task and the scout report, without seeing the plan. The **comparator** pairs
the two clause sets by id and returns `same | differs | missing_in_plan |
missing_in_shadow`. Two blind planners that disagree have found an ambiguity in the
task — exactly what one planner resolves silently.

Questions are built by the script from verbatim clause fields, in this priority:

1. `missing_in_plan` — a risky behavior only the shadow wrote down;
2. `differs` — "Non-admin calls `/export`: plan expects `403`, shadow expects
   `404`. Which?";
3. clauses the critic still flags;
4. council concerns the planner rejected, with its reason;
5. `overreach` spec gaps (at slice checkpoints).

Beyond 5, the rest go to the ledger and the checkpoint says the task is
underspecified. At low risk there is no shadow and no checkpoint; the clause check
is the only guard.

`approve.hash` must equal the sha256 of the plan the questions came from. Each
`no` or correction goes back to the planner once; the corrected plan gets a new
hash, and only new disagreements produce new questions. The ledger records the
hash, the SHA, each question, and each answer verbatim.

## 9. Build (8)

The builder gets the slice JSON, the scout report path, and dependency slice paths.

```
commit A  "S2 tests"   one test per clause, plus stubs so tests compile
                       (throw / todo!() bodies, signatures only)
judge                  every (clause, builder test) pair, before any code
commit B  "S2 impl"    implementation
```

All on `forge/<id>/main`. The builder edits; the runner commits and returns SHAs.

**Judge on builder tests.** Before commit B, the judge receives each clause and its
test — no stub, no code — and returns `valid | too_weak | overreach | wrong_oracle`.
Trigger it guards: clause expects `401`, test asserts `not.toBe(200)`; it fails
against the stub and passes when the code returns `500`. `too_weak` and
`wrong_oracle` send the test back to the builder once, then escalate.

**What "fails correctly at A" means.** No signal detects "an assertion" across every
framework. The rule is: the test is collected, it executes, and it fails, and the
failure is not in the per-framework setup-error list (import, compile, fixture,
timeout). Use JUnit XML output where the framework has it: vitest, jest, bun,
pytest `--junitxml`, `cargo nextest`. Stubs at A are what make this reachable in
compiled languages.

The runner checks, with raw tails logged:

1. at A: `behavior`, `negative`, `migration`, `concurrency` and `property` tests
   fail correctly; `preserve` tests pass, and also passed at the base commit;
2. at B: every clause test passes;
3. the tree is clean before each run — no untracked or modified file;
4. `git diff --name-only` stays inside `files`; extras are flagged for review;
5. no protected file changed; if one did, the slice blocks.

Two attempts per slice. A `Blocked on` report or a second failure stops the slice
and escalates; the ledger records `[failed]`.

## 10. Duel (9)

```
runner: git worktree add --detach <path-red> <A>, install deps
red, in that worktree (A holds stubs, no implementation)
  → ≤ 5 bugs; per bug TWO test variants, each a NEW file
  → commit on forge/<id>/red-S2-r1-a1   (one branch per attacker)
runner: scratch worktree at B, checkout the red files onto it
  → keep variant pairs that fail correctly and cite a clause id
judge (clause + variant 1, never the code)
  → valid | overreach | wrong_oracle
runner: checkout variant 1 of valid bugs onto forge/<id>/main
  → commit R
blue sees variant 1 only → fixes the root cause, or rejects
  → runner commits F
runner: recheck at F — variant 1, the HELD-OUT variant 2,
  clause tests, fast suite; anti-tamper
```

Branch names avoid a git ref conflict: `forge/<id>/main` and
`forge/<id>/red-<slice>-r<round>-a<attacker>` can coexist; `run/<id>` and
`run/<id>/red-…` cannot.

- **Attackers per slice:** low risk → 1 (sonnet for S, opus for M/L). High risk → 2:
  opus + gpt, or two opus with distinct lenses (boundary inputs; state and failure
  paths). Codex attackers run with `-s workspace-write` inside their worktree.
- **Red writes new files only.** Moving them onto B or `main` is then a
  conflict-free `git checkout <red-sha> -- <files>`.
- **overreach** is a spec gap, not a bug: reported at checkpoint or close, never
  fixed silently. **wrong_oracle** is discarded.
- **Blue rejects** go to the human, not to another model.
- **Held-out variant.** Blue never sees variant 2. A fix that special-cases the
  visible test fails the hidden one. This replaces a literal scan, which flags every
  correct boundary fix (`qty > 100`) and every `0` or `""`.
- **Anti-tamper:** `git diff R F -- <red test files>` must be empty, and no protected
  file may change.
- **Concurrency-kind tests** break the 3-out-of-3 rule on purpose: a race fails
  intermittently. At B, at least 1 failure in 20 runs keeps the test. At F, 0
  failures in 20 runs are required. Other kinds keep 3 out of 3 at B.
- **Recheck** at F: both variants, clause tests, fast suite.
- **Rounds:** at most 2. Round 2 runs if round 1 produced a valid bug, OR if
  mutation left survivors.
- **Mutation** (high-risk slices), limited to the diff: StrykerJS `--mutate
  file:lines`, cargo-mutants `--in-diff`. It runs after round 1. Survivors trigger
  round 2 by themselves: red gets the surviving mutants and writes tests that kill
  them when a clause requires it. Mutation never gates the merge; it aims the next
  attack, which matters most when round 1 found nothing.
- Valid, fixed red tests — both variants — stay in the suite as regression tests.

## 11. Close (10–11)

1. Runner: full suite, typecheck, lint, at the final commit, raw tails logged.
2. Reviewer, targeted to what tests cannot see: scope (`out_of_scope` list),
   speculative structure (deletion test), residue, untestable security, and any
   diff not traceable to a clause. Its prompt names the range explicitly —
   `git diff <base>..forge/<id>/main` — because its default `git diff` reads the
   working tree, which is empty on committed work. Blocking findings → one
   implementer round → runner recheck; else the human.
3. The script renders the report from artifacts: per slice clauses, tests, red
   outcomes, spec gaps, surviving mutants, out-of-scope files, dismissed signals.
   Cost per phase comes from `budget.spent()` deltas, labeled "output tokens,
   approximate": it counts output only, for the whole turn, and cached replays
   count almost nothing.
4. The runner removes every red and scratch worktree. The run worktree stays until
   the human merges.
5. Nothing merges automatically.

## 12. State

```
.claude/runs/<id>/        in the user's repo, excluded via .git/info/exclude
  run.json                phase, status, tier, risk, args, last SHA,
                          worktree paths (for crash cleanup)
  triage.json  scout.json  council.json  plan.json
  slices/<id>.json        build + duel result
  ledger.md               append-only
```

**Scribe protocol.** The script passes a path and exact content. The scribe writes
it and returns `shasum -a 256 <path>` and `wc -c <path>`. The script computes the
sha256 of the content itself (pure JS, about 40 lines) and compares. A mismatch
fails the write. A scribe that skips the write, truncates, or retypes cannot forge
the hash, and no file content is echoed back as output tokens.

Writes are batched: one scribe call per phase boundary, never per artifact. Each
agent spawn re-injects the user's CLAUDE.md, so spawn count is a real cost.

Ledger lines are composed by the script from runner facts:

```
[verified] bun test → 0 @a1b2c3d
[decision] plan <hash> approved @a1b2c3d — q1: "yes" · q2: "no: 404, not 403"
[failed]   S2 attempt 2 — Blocked on: <ref>
[dismissed] persistence: <reason> @a1b2c3d
```

**Resume** reads disk only. The scribe returns `run.json` and artifacts under a
schema, plus the sha256 of each file; the script recomputes and compares. If the
run worktree's HEAD equals the last SHA, continue. If not, every fact at an older
SHA is stale; the runner re-verifies the current slice before any new phase.

The Workflow `resumeFromRunId` cache is a same-session bonus, never the mechanism:
a fresh session has nothing to resume. To keep the cache useful, agent prompts must
not embed `args` values that change between relaunches, such as `approve`.

**Checkpoint.** The orchestrator writes state, returns `{status: "checkpoint",
planHash, …}`, and stops. Relaunch with `resume` and `approve`.

## 13. Weak points

| Weak point | Mitigation | Still open |
|---|---|---|
| A clause is wrong: everything agrees, all wrong | clause check at every level, required kinds per signal; at high risk a blind shadow planner and question checkpoint | the single largest risk: at low risk, a wrong-but-clear clause of the right kind passes all of it |
| Builder test only beats a stub | judge on every (clause, builder test) pair | judge and builder can share a misreading |
| Triage misclassifies | two re-triages (code, plan), risk only rises | a risk nobody can see stays invisible |
| Judge accepts a wrong oracle | judge has no tools and never sees code | judge and red can share an error |
| Blue special-cases tests | read-only red files, held-out variant | red can write two variants with one blind spot |
| Harness weakened | run worktree, clean-tree check, protected files | a harness file not on the list |
| Flaky red test | 3/3 runs; concurrency kind 1/20 then 0/20 | rare races beyond 20 runs |
| Red reads commit B via git | worktree at A, stubs only | enforced by instruction, not guaranteed |
| Stubs at A reveal the API shape to red | signatures only, no bodies | red still sees the chosen interface |
| A model misreports a write or a run | sha256 and `git rev-parse` compared in code, raw tails logged | the runner could still mislabel which test failed |
| Schema drops an implicit decision | bounded `notes` field per contract | notes can still be too short |
| Human rubber-stamps | ≤ 5 closed questions from shadow-planner disagreements and flags, never "approve this plan"; hash-bound answers | an ambiguity both planners resolve the same wrong way yields no question |
| Cost | dosing, batched scribe writes, approximate cost per phase | no baseline yet vs `big-feature` |

## 14. Verification of forge itself

Written before implementation. A fixture repo under `forge/fixtures/` with a known
task, and a check script that asserts:

1. each slice has commits A and B; clause tests fail correctly at A and pass at B;
2. a weak builder test (`not.toBe(200)` for a clause expecting `401`) is returned
   by the judge as `too_weak`;
3. a red test that only restates the implementation is rejected by the judge;
4. a blue fix that edits a red test file is flagged by anti-tamper;
5. a blue fix that special-cases variant 1 fails the held-out variant 2;
6. a builder change to the test config blocks the slice as a protected file;
7. a planted bug that violates a clause is caught as a valid red test and fixed;
8. an `auth` task whose plan lacks a `negative` clause fails the plan check;
9. resume after a manual commit marks older facts stale and re-verifies;
10. a scribe that returns without writing fails the hash check;
11. an approval whose hash differs from the shown plan is refused;
12. a low-risk S task never reaches council or a checkpoint;
13. a planted ambiguity in a high-risk task ("only admins may export", status code
    unspecified) surfaces as a checkpoint question, and no checkpoint shows more
    than 5 questions.

## 15. Out of scope

- The SessionStart(compact) hook for interactive sessions. Separate sub-project,
  same ledger format.
- Automatic merge.
- Cross-run yield statistics beyond what each report prints.

## 16. Unknowns

- No study compares a dosed pipeline, or a red/blue duel, with a fixed pipeline or
  a single agent plus tests. Per-phase cost and outcomes are logged from the first
  run to settle it on real data.
- Whether `workflow('forge-duel')` resolves by file name or by `meta.name`: check
  before writing the orchestrator.
- The per-framework setup-error list (§9): build it from each supported runner's
  JUnit output, starting with the frameworks the fixtures use.

Resolved by review:

- `isolation: 'worktree'` branches from the remote default branch under the user's
  `worktree.baseRef: "fresh"`, never from an arbitrary SHA. Hence explicit
  `git worktree add` by the runner (§10).
- `workflow({scriptPath})` requires a path the session can already read. Hence
  named workflows (§4).
- A child workflow shares the parent's budget, concurrency cap and abort signal;
  `workflow()` inside a child throws.
- `agentType` and `schema` compose; the StructuredOutput instruction replaces the
  agent's prose report format.
- StrykerJS `--mutate file:lines` and cargo-mutants `--in-diff` exist. StrykerJS
  takes line ranges and cargo-mutants reads a diff file; the runner produces both
  from `git diff <A>..<B>`. cargo-mutants `--in-diff` misses effects outside the
  diffed lines — acceptable, since mutation only aims attacks.
