## Planning

- Use **plan mode** when the change touches multiple files, the approach is
  unclear, or the code is unfamiliar.
- If the diff fits in one sentence, skip the plan and just do it.
- For real plans: phase-gated, each phase lists files touched, verification
  step, and exit criterion.
- **Vertical slice over horizontal layering.** Each plan phase must touch
  data + behavior + test. Reject plans that build whole layers in isolation —
  agents over-build horizontally without a slice constraint.
- Before coding, challenge the plan: *"Grill this as a staff engineer. What breaks?"*
- Prototype over PRD when the cost of a wrong spec exceeds the cost of a throwaway build.

---

## Execution

- Smallest change that solves the problem. No drive-by refactors. No
  opportunistic renames.
- Match local conventions. Read 2–3 neighboring files before adding new ones.
- No speculative abstractions. No interfaces with one implementer.
- Comments explain *why*, not *what*. Never narrate the diff in a comment.
- Finish migrations. Never leave the codebase half-migrated between two patterns.
- If a test is wrong, fix it and flag it. Never disable a test / rule / type
  to make green.

---

## Formatting & Style

Style is the linter and formatter's job — a PostToolUse hook runs them
automatically on edit. Don't pre-format, don't invent style rules, don't argue
with the hook: let it run and address what it surfaces.

---

## Debugging

- **Reproduce before diagnosing.** Then write a failing test that captures the
  bug, then fix. The test prevents regression.
- Run failing processes as background tasks so logs stream; do not guess output.
- Ask for screenshots, console logs, or DOM when UI behavior is unclear.
- Use Chrome / Playwright / DevTools MCP when available instead of narrating.
- After a fix: *"Knowing what you know now, is this the elegant solution?
  If not, redo."*
