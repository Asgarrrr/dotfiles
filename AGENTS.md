# AGENTS.md

Global AI hub for this machine.

## Source Of Truth

- shared skills live in `./.agents/skills`
- global Claude instructions live in `./.agents/claude/CLAUDE.md`
- global Codex preferences live in `./.agents/codex/config.toml`
- global Claude Code preferences live in `./.agents/claude/settings.json`

## Scope

- version only stable agent config and reusable skills
- do not version caches, session history, sqlite files, plugins, auth, or other runtime state
- keep repo-local Claude permissions in `./.claude/settings.local.json`

## Maintenance

- use `just ai-link` to relink the global AI setup
- use `just ai-doctor` to verify commands and links
- `~/.agents/skills` and `~/.claude/skills` are both symlinks to `./.agents/skills`; every skill lives there, third-party ones included
- stack-specific skills are `"off"` in `skillOverrides` of `./.agents/claude/settings.json`; switch one on per project with `"on"` in its `.claude/settings.local.json` (`/skills` picker or `/suggest-skills`), keyed by directory name
- never run `npx skills add -g` or `npx skills update -g`: it `rm -rf`s the target and writes straight into this repo; update a third-party skill by copying upstream into `./.agents/skills` and committing
- Claude in Chrome is off by default (its tools cost ~10k tokens per request): start with `claude --chrome` when needed
