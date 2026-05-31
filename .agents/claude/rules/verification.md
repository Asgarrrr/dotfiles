## Verification

"It compiles" is not verification.

1. Run the project's actual build / typecheck / lint / test commands.
2. Exercise the behavior — test, integration run, or manual run with logs.
3. **If I give you a task without a verification target, ask for one or propose
   one (test, script, expected output) before implementing.**
4. If verification is impossible (no creds, no runtime), state it explicitly
   in the summary.
5. Before "done", diff against the base branch and re-read every hunk. Delete
   anything unnecessary.
6. **Builder ≠ verifier.** If the change touches ≥3 files OR the diff exceeds
   100 lines, spawn a fresh-context `code-reviewer` subagent before signaling
   done (read-only: Read / Grep / Glob + Bash for `git diff` / lint / tests —
   no Edit / Write). Self-review carries anchoring bias.
7. **Evidence > sentiment.** "Tests pass" is a claim, not evidence. Evidence is:
   command run, exit code, last lines of stdout, `git diff --stat`. Paste it.
