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
  # simple command is checked on its own, so `rm x; ls -R; grep -f p` passes.
  # Wrappers like sudo/xargs are skipped with their flags only: `sudo -u root rm`
  # slips through, an accepted gap for a guard that is not a sandbox.
  rm_cmd='^[[:space:]]*((sudo|doas|xargs|command|env|nohup|time|exec)([[:space:]]+-[^[:space:]]+)*[[:space:]]+|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*([^[:space:]]*/)?rm([[:space:]]|$)'
  recursive='(^|[[:space:]])(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|$)'
  force='(^|[[:space:]])(-[a-zA-Z]*f[a-zA-Z]*|--force)([[:space:]]|$)'
  while IFS= read -r seg; do
    if printf '%s' "$seg" | grep -qE "$rm_cmd" \
      && printf '%s' "$seg" | grep -qE "$recursive" \
      && printf '%s' "$seg" | grep -qE "$force"; then
      deny "Blocked: rm -rf is forbidden. Use \`trash <file>\` or ask for explicit confirmation."
    fi
  done < <(printf '%s\n' "$cmd" | tr ';&|(){}`' '\n\n\n\n\n\n\n\n')

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
