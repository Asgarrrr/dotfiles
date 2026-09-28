## Verification

"It compiles" is not verification.

1. Every non-trivial task starts with an executable success criterion — a
   failing test, or a script with expected output — written BEFORE the
   implementation. Task arrives without one → propose one, then build.
   A test that still passes with a plausible bug injected is not a criterion.
2. Run the project's real build / typecheck / lint / test commands AND
   exercise the behavior (test, integration run, or manual run with logs).
3. Builder ≠ verifier: diff touches ≥3 files or exceeds 100 lines → run
   `/code-review` before signaling done.
4. Before "done": diff against base, re-read every hunk, delete anything
   unnecessary — TODOs, dead code, debug prints, commented-out blocks.
5. Evidence > sentiment. Evidence is: command run, exit code, last lines of
   stdout, `git diff --stat`. Paste it.
6. Verification impossible (no creds, no runtime) → state it explicitly.
