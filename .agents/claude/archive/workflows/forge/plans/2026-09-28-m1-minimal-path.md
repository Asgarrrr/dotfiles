# forge M1 — minimal path — Plan

**Goal:** a low-risk S task runs end to end in the sim: triage, plan, build (A, judge, B), one attacker, close. Target checks: 1, 2, 10, 12. The duel and plan-check code are written generically, so 3–8 may turn green early. Checks 9, 11, 13 need checkpoint and resume (M3).

## Code layout

- `src/lib.js` — pure functions: sha256, JUnit parse, triage rules, plan checks, porcelain parse, protected files, shell quoting, ledger lines. Exported for `bun test`; `export` is stripped at build.
- `src/runtime.js` — helpers that call the `agent` global: `stop`, `run` (runner), `persist` (scribe + hash check), `runTests`, prompts, schemas. Tested only through the scenarios.
- `src/phases/<name>.js` — one per workflow: `forge`, `forge-triage`, `forge-plan`, `forge-build`, `forge-duel`, `forge-close`. Each starts with its `meta` literal and has a `// @lib` line where the build inserts lib + runtime.
- `build.js` — writes `../<name>.js`; `bun build.js --check` exits 1 on a stale file. `harness/build.test.js` runs the check.

## Decisions (beyond SPEC)

1. **Worktrees live outside the repo:** `<dir>.forge/<runId>/main`, red and scratch beside it. Inside `<dir>` they would be collected by the user's own `bun test`.
2. **Only the orchestrator persists.** Phases return `{stop?, writes, ledger}`; the orchestrator does one scribe call per phase boundary. A phase never throws a forge stop across `workflow()`: error objects may not survive the boundary.
3. **The judge runs before commit A**, on sources extracted by the runner (`sed -n a,bp`). A `too_weak` retry then never rewrites history; `B~1 == A` holds.
4. **B attempt 2 amends B** (local run branch, never shared), so `B~1 == A` still holds.
5. **Held-out variant 2 lands on main only after F** is rechecked, so blue never sees it and `git diff R F -- <red files>` stays empty.
6. **JUnit via grep stream:** the runner returns `grep -oE` of `<testcase …>`, `</testcase>`, `<failure type=…`, not the full XML. A smaller transcription surface; `parseJunit` reads both forms.
7. **`dir` must be absolute.** A script cannot read cwd; the SPEC default is unreachable.
8. **Unimplemented branches stop explicitly:** council, shadow, checkpoint, resume, mutation, round 2 → `{status: 'error', reason: 'not implemented in M1: <x>'}`. Replaced in M2/M3.
9. **Bug status `overreach`** is added to the contract list: a spec gap, reported, never fixed.

## Tasks

1. `lib.js` + `src/lib.test.js`, test-first: sha256 against node crypto at padding boundaries; JUnit parse (full and grep forms, escapes, self-closing, absent = not-collected); `checkPlan`; `sizeOf`/`riskOf`/raise-only; porcelain parse; `isProtected`; `q`.
2. `build.js` + `harness/build.test.js` (freshness).
3. `runtime.js` + `forge-triage` + a skeletal `forge` — check 10 green.
4. `forge-plan` — check 8 green.
5. `forge-build` — checks 2, 6 green.
6. `forge-duel` (1 round, N attackers) — checks 3, 4, 5, 7 green.
7. `forge-close` — checks 1, 12 green.
8. `/code-review`, then fix.
