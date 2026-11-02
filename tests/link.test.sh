#!/usr/bin/env bash
# Runs `just ai-link` against a throwaway HOME and checks every link.
# Run: just test (or bash tests/link.test.sh)
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1"; fail=$((fail+1)); }

home="$(mktemp -d)"
ai_link() { HOME="$home" just -f "$repo/justfile" ai-link >/dev/null 2>&1; }

echo "ai-link:"
ai_link && ok "runs on an empty HOME" || bad "runs on an empty HOME"
for pair in \
  .claude/CLAUDE.md:.agents/claude/CLAUDE.md \
  .claude/settings.json:.agents/claude/settings.json \
  .claude/hooks:.agents/claude/hooks \
  .claude/rules:.agents/claude/rules \
  .claude/agents:.agents/claude/agents \
  .claude/commands:.agents/claude/commands \
  .claude/workflows:.agents/claude/workflows \
  .claude/templates:.agents/claude/templates \
  .claude/skills:.agents/skills \
  .agents/skills:.agents/skills; do
  link="$home/${pair%%:*}"; target="$repo/${pair#*:}"
  [[ -L "$link" && "$(readlink "$link")" == "$target" ]] && ok "${pair%%:*}" || bad "${pair%%:*} -> ${pair#*:}"
done
ai_link && [[ ! -e "$repo/.agents/claude/agents/agents" ]] && ok "re-run does not nest links" || bad "re-run does not nest links"

# Missing commands (claude on a fresh machine) are not this test's concern.
! HOME="$home" just -f "$repo/justfile" ai-doctor 2>/dev/null | grep -qE 'MISS (/|skillOverrides|cannot)' \
  && ok "ai-doctor finds no missing link" || bad "ai-doctor finds no missing link"

trash "$home"; home="$(mktemp -d)"
mkdir -p "$home/.claude/agents"
! ai_link && [[ ! -L "$home/.claude/agents/agents" ]] && ok "refuses a real directory in the way" || bad "refuses a real directory in the way"
trash "$home"

echo "—"
echo "passed: $pass  failed: $fail"
[[ $fail -eq 0 ]]
