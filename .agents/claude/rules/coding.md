## Coding

- Plan mode when the change is multi-file, the approach unclear, or the code
  unfamiliar. Diff fits in one sentence → skip the plan and do it. Plans are
  vertical slices (each phase touches data + behavior + test), never
  horizontal layers. Grill the plan as a staff engineer before coding.
- Smallest change that solves the problem. No drive-by refactors, no
  opportunistic renames, no speculative abstractions, no interfaces with one
  implementer.
- Match local conventions: read 2–3 neighboring files before adding one.
- A comment carries what the code cannot: an external format, a constraint, a
  rejected alternative. Never explain the language, never restate the line, never
  recount history — git holds that. State a fact plainly; a spec does not expire.
  A decision must name what would prove it stale: `golden-locked` is an axiom the
  next agent obeys blindly, `locked by test/x.test.ts` is a claim it can re-run.
  An unfalsifiable reason freezes a choice that may already be the wrong one.
- Never disable a test, lint rule, or type to get green — fix it and flag it.
- Formatting is the PostToolUse hook's job: don't pre-format, don't argue,
  address what it surfaces.
- Debugging: reproduce → failing test that captures the bug → fix. Run failing
  processes as background tasks so logs stream; never guess output. Use
  browser/DevTools MCPs instead of narrating UI behavior.
