## Coding

- Plan mode when the change is multi-file, the approach unclear, or the code
  unfamiliar. Diff fits in one sentence → skip the plan and do it. Plans are
  vertical slices (each phase touches data + behavior + test), never
  horizontal layers. Grill the plan as a staff engineer before coding.
- Smallest change that solves the problem. No drive-by refactors, no
  opportunistic renames, no speculative abstractions, no interfaces with one
  implementer.
- Match local conventions: read 2–3 neighboring files before adding one.
- A comment carries what the code cannot: an external format, a constraint, an
  alternative that was rejected for a reason that would not be obvious. Never
  explain the language, never restate the line. Test it by tense — a comment
  constrains the next edit, it does not recount the last one. History lives in
  git, not above the function.
- Never disable a test, lint rule, or type to get green — fix it and flag it.
- Formatting is the PostToolUse hook's job: don't pre-format, don't argue,
  address what it surfaces.
- Debugging: reproduce → failing test that captures the bug → fix. Run failing
  processes as background tasks so logs stream; never guess output. Use
  browser/DevTools MCPs instead of narrating UI behavior.
