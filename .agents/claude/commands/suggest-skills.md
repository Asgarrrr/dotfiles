---
description: Detect this project's stack and enable the matching stack skills (no need to know skill names)
argument-hint: [project-dir]
allowed-tools: Bash(*/suggest-skills.sh*)
---

Run `~/dotfiles/.agents/claude/suggest-skills.sh ${1:-.}` (no `--yes` — dry run,
it'll print detected matches and skip enabling since there's no TTY to confirm).

Show me what it detected. Then ask me whether to enable them.

If I confirm, run `~/dotfiles/.agents/claude/suggest-skills.sh ${1:-.} --yes` to
set them to "on" in the project's `.claude/settings.local.json`, then confirm
what was enabled.
