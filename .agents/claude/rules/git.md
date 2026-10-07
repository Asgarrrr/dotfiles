## Git & PRs

- Branch per change. Never commit directly to `main` / `master` / `develop`.
- One logical change per commit. Imperative subject. Body explains *why* when
  non-obvious.
- Keep PRs small (target ~150 lines of diff, one feature). Split when they grow.
- Squash-merge by default: one commit per feature on the main branch keeps
  `git bisect` and `git revert` clean.
- Never force-push or amend shared branches unless asked.
- PR description: **context, what changed, how to verify, risk / rollback**.
- Never `git stash` when agents work in parallel worktrees: the stash list is shared by every worktree. Commit work in progress instead.
