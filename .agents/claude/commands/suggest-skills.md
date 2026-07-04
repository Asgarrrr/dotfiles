---
description: Detect this project's stack and link the matching pool skills (no need to know skill names)
argument-hint: [project-dir]
allowed-tools: Bash(*/suggest-skills.sh*)
---

Run `~/dotfiles/.agents/claude/suggest-skills.sh ${1:-.}` (no `--yes` — dry run,
it'll print detected matches and skip linking since there's no TTY to confirm).

Show me what it detected. Then ask me whether to link them.

If I confirm, run `~/dotfiles/.agents/claude/suggest-skills.sh ${1:-.} --yes` to
actually create the symlinks, then confirm what was linked.
