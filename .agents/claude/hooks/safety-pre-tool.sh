#!/usr/bin/env bash
# PreToolUse: block destructive operations before execution.
# Bypass for one call: export CLAUDE_SKIP_SAFETY_HOOK=1

set -uo pipefail

[ "${CLAUDE_SKIP_SAFETY_HOOK:-0}" = "1" ] && exit 0

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)

[ -z "$tool_name" ] && exit 0

deny() {
  jq -nc --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

if [ "$tool_name" = "Bash" ]; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  [ -z "$cmd" ] && exit 0

  # rm with both a recursive and a force flag, in any spelling or order. Each
  # simple command is checked on its own, and only the arguments after rm, so
  # `rm x; ls -R` and `xargs -r rm -f` pass. Pure bash matching: a fork per
  # line made long heredocs exceed the hook timeout, which fails open.
  # Known gaps for a guard that is not a sandbox: a wrapper option that takes
  # an argument (`sudo -u root rm -rf`), and quoted text or heredoc lines are
  # read as commands, so `git commit -m "...; rm -rf ..."` is denied.
  if [[ "$cmd" == *rm* ]]; then
    wrapper='(sudo|doas|xargs|command|env|nohup|nice|time|timeout|exec|do|then|else|!)([[:space:]]+(-[^[:space:]]+|[0-9][^[:space:]]*))*[[:space:]]+'
    assign='[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+'
    rm_at='(^[[:space:]]*('"$wrapper"'|'"$assign"')*|-exec(dir)?[[:space:]]+)\\?([^[:space:]]*/)?rm([[:space:]]|$)'
    recursive='(^|[[:space:]])(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|$)'
    force='(^|[[:space:]])(-[a-zA-Z]*f[a-zA-Z]*|--force)([[:space:]]|$)'
    continuation=$'\\\n'
    while IFS= read -r seg; do
      [[ "$seg" =~ $rm_at ]] || continue
      args=" ${seg#*"${BASH_REMATCH[0]}"}"
      if [[ "$args" =~ $recursive && "$args" =~ $force ]]; then
        deny "Blocked: rm -rf is forbidden. Use \`trash <file>\` or ask for explicit confirmation."
      fi
    done < <(printf '%s\n' "${cmd//"$continuation"/ }" | tr ';&|(){}`' '\n\n\n\n\n\n\n\n')
  fi

  # The flag must stand as its own word: the old `.*(-f|--force)` matched any
  # branch carrying a hyphen-f, so `git push origin feat/custom-field-filters`
  # read as a force push.
  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)git\s+push\s+(.*\s)?(-f|--force|--force-with-lease=[^ ]*)(\s|$)'; then
    deny "Blocked: git push --force on shared branches is forbidden. Use --force-with-lease or ask for confirmation."
  fi

  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)git\s+reset\s+--hard'; then
    deny "Blocked: git reset --hard is irreversible. Confirm explicitly before proceeding."
  fi

  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)git\s+clean\s+-[a-zA-Z]*f'; then
    deny "Blocked: git clean -f is irreversible. Confirm explicitly before proceeding."
  fi

  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)git\s+(checkout\s+--\s+\.|restore\s+\.)'; then
    deny "Blocked: git checkout -- . / git restore . discards all unstaged changes. Confirm explicitly before proceeding."
  fi

  if printf '%s' "$cmd" | grep -qiE '(^|[;&|]\s*)(DROP\s+TABLE|TRUNCATE\s+(TABLE\s+)?\w)'; then
    deny "Blocked: DROP TABLE / TRUNCATE are irreversible. Confirm explicitly before proceeding."
  fi
fi

exit 0
