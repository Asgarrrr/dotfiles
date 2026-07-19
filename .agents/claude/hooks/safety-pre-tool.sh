#!/usr/bin/env bash
# PreToolUse: block destructive operations from CLAUDE.md §11 before execution.
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

  # Destructive patterns from CLAUDE.md §11
  # rm with BOTH a recursive and a force flag (any order/spelling, incl. sudo,
  # interspersed flags, and long forms). Deliberately conservative: it may block
  # a benign command that pairs an unrelated -f elsewhere — bypass with
  # CLAUDE_SKIP_SAFETY_HOOK=1 when that happens.
  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)(sudo\s+)?rm\b' \
     && printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-[a-zA-Z]*r[a-zA-Z]*|--recursive)([[:space:]]|$)' \
     && printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-[a-zA-Z]*f[a-zA-Z]*|--force)([[:space:]]|$)'; then
    deny "Blocked: rm -rf is forbidden (CLAUDE.md §11). Use \`trash <file>\` or ask for explicit confirmation."
  fi

  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)git\s+(push\s+.*(-f|--force)|push\s+--force)'; then
    deny "Blocked: git push --force on shared branches is forbidden (CLAUDE.md §11). Use --force-with-lease or ask for confirmation."
  fi

  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)git\s+reset\s+--hard'; then
    deny "Blocked: git reset --hard is irreversible (CLAUDE.md §11). Confirm explicitly before proceeding."
  fi

  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)git\s+clean\s+-[a-zA-Z]*f'; then
    deny "Blocked: git clean -f is irreversible (CLAUDE.md §5). Confirm explicitly before proceeding."
  fi

  if printf '%s' "$cmd" | grep -qE '(^|[;&|]\s*)git\s+(checkout\s+--\s+\.|restore\s+\.)'; then
    deny "Blocked: git checkout -- . / git restore . discards all unstaged changes (CLAUDE.md §5). Confirm explicitly before proceeding."
  fi

  if printf '%s' "$cmd" | grep -qiE '(^|[;&|]\s*)(DROP\s+TABLE|TRUNCATE\s+(TABLE\s+)?\w)'; then
    deny "Blocked: DROP TABLE / TRUNCATE are irreversible (CLAUDE.md §11). Confirm explicitly before proceeding."
  fi
fi

exit 0
