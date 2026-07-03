---
description: Detect this project's stack and suggest dotfiles-skills plugins to enable
argument-hint: [project-dir]
allowed-tools: Bash(*/suggest-plugins.sh*)
---

Run `~/dotfiles/.agents/claude/suggest-plugins.sh ${1:-.}` (no `--yes` flag — this
is a dry run, it will print the suggested plugins and skip writing since there's
no TTY to confirm).

Show me the detected plugins from the output. Then ask me whether to enable them.

If I confirm, run `~/dotfiles/.agents/claude/suggest-plugins.sh ${1:-.} --yes` to
actually write `.claude/settings.json`, then confirm what was written.
