---
name: brainstorm
description: Shape an unclear feature or design with the user before any plan exists — one question at a time, 2-3 approaches, and a local browser companion for mockups and diagrams. Use when the user says "brainstorm", "explore this idea", "show me options", or asks for something whose intent or design is still open. Skip it when the task is already specified.
---

# Brainstorm

Turn an open idea into an approved design through dialogue. The output is a design
the user approved, ready to implement. No production code.

## Steps

1. Read the project context: CLAUDE.md, the relevant files, recent commits.
2. If upcoming questions are visual (layouts, mockups, diagrams), offer the visual
   companion in its own message and wait for the answer:
   > "Some of this is easier to show than describe. I can put mockups and diagrams
   > in a local browser page as we go. It costs extra tokens. Want to try it?"
3. Ask clarifying questions, one per message, multiple choice when possible:
   purpose, constraints, success criterion.
4. If the request spans several independent subsystems, say so first and pick one
   to design.
5. Propose 2-3 approaches with trade-offs. Lead with your recommendation and why.
   Before the user picks, challenge your recommendation: `advisor` on the design,
   `researcher` on any library or API not yet confirmed. Report what they found,
   including dissent. Challenge here, not during implementation; if implementation
   exposes a gap or contradiction, stop and amend the spec with the user. If a
   trade-off hinges on a measurement, run `/prototype` (throwaway) before the
   user picks, and report the numbers.
6. Present the design in sections sized to their complexity, and confirm each one:
   components, data flow, error handling, how it is tested.
7. Write the approved design to the project's plans directory (`docs/plans/` unless
   its CLAUDE.md says otherwise). End it with the slice list: run `slice-check` on
   it and size each slice to one session. A slice that outgrows one session is
   resized in the spec, never split ad hoc. Before the user approves, get a
   second-model read: `codex exec -C <dir> -s read-only --ephemeral -m gpt-6-sol
   -c model_reasoning_effort=high` on the original request against the spec —
   uncovered requirements, edge cases, slice boundaries. Report its findings,
   including dissent. Commit only if the user asks.
8. Hand off by size, per the Delegation rules in the global CLAUDE.md. Fits one
   session: implement it solo in a fresh session, then `/code-review` against the
   spec. Larger: one `implementer` per slice, in sequence. Do not plan or implement
   here.

## Visual companion

Use the browser only when seeing beats reading: mockups, layout comparisons,
architecture diagrams. Text choices, scope and trade-offs stay in the terminal.

Once the user accepts, read `visual-companion.md` in this skill's directory before
starting the server. Scripts live in `scripts/`. Pass `--project-dir` so mockups
persist in `.superpowers/brainstorm/`, and check that `.superpowers/` is gitignored.

Visual companion: copied from obra/superpowers (MIT, see LICENSE).
