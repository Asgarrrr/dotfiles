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
- `~/.agents/skills` is the skill catalog; only `./.agents/claude/skills.txt` loads globally
- use `just skills` to list the catalog, `just skill-on <name> [global|project]` and `just skill-off` to switch one
- Claude in Chrome is off by default (its tools cost ~10k tokens per request): start with `claude --chrome` when needed
