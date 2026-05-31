#!/usr/bin/env bash
# Stop hook: enforce ~/.claude/CLAUDE.md §13 (evidence on completion claims).
#
# Strategy
# --------
# 1. Parse the last assistant message for *specific* claim categories
#    (tests, typecheck, lint, build, ready-to-merge) and a *generic*
#    "done"/"all green"/"tout vert" claim.
# 2. For each specific claim, scan the recent transcript for a matching
#    Bash tool_use that completed without error. If none, the claim is
#    unsupported and the hook blocks with an actionable reason.
# 3. For a "ready to merge" claim, additionally check `git status` in
#    the session CWD; uncommitted/untracked files contradict the claim.
# 4. For a generic-only claim (no specific category triggered), fall
#    back to the v1 rule: require a fenced code block or an explicit
#    "verification skipped because …" mention.
#
# Fail-open: any error short-circuits to exit 0. The hook never blocks
# on its own bugs.
#
# Bypass for one session: export CLAUDE_SKIP_VERIFY_HOOK=1
# Debug log:              export CLAUDE_VERIFY_HOOK_DEBUG=/tmp/verify-on-stop.log

set -uo pipefail

[ "${CLAUDE_SKIP_VERIFY_HOOK:-0}" = "1" ] && exit 0

DEBUG_LOG="${CLAUDE_VERIFY_HOOK_DEBUG:-}"
log() { [ -n "$DEBUG_LOG" ] && printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> "$DEBUG_LOG"; }

input=$(cat)

transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)
stop_hook_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)

[ "$stop_hook_active" = "true" ] && exit 0
[ -z "$transcript_path" ] && exit 0
[ ! -f "$transcript_path" ] && exit 0

log "hook fired, transcript=$transcript_path cwd=$cwd"

# ----- Last assistant message text ---------------------------------------
last_assistant_line=$(awk '/"type":"assistant"/{last=$0} END{print last}' "$transcript_path" 2>/dev/null || true)
last_text=$(printf '%s' "$last_assistant_line" \
  | jq -r '.message.content[]? | select(.type=="text") | .text' 2>/dev/null \
  || true)

[ -z "$last_text" ] && exit 0

matches() { printf '%s' "$1" | LC_ALL=C grep -qiE "$2"; }

# ----- Claim detection ---------------------------------------------------
# Specific claims tie to a named verification gate.
tests_claim_re='\b(tests? pass|all tests pass|test suite (pass|green)|✓ +[0-9]+ tests?|[0-9]+ tests? passed|no failing tests|tests? are (passing|green)|test green)\b'
typecheck_claim_re='\b(type[- ]?check (pass|ok|clean|green)|no type errors|types? (are )?(clean|ok)|tsc (pass|clean|green|ok)|types pass)\b'
lint_claim_re='\b(lint (pass|clean|green|ok)|no lint (errors|issues|warnings)|linter happy|biome (pass|clean|green)|eslint (pass|clean|green))\b'
build_claim_re='\b(build (succeeds|passes|works|ok|clean|green)|compiled successfully|compiles cleanly|build is green)\b'
merge_claim_re='\bready to (merge|ship|deploy|land)\b'

# Generic "completion" claims (handled with a softer fenced-block fallback).
generic_claim_re='(\ball green\b|\btout vert\b|\btask complete\b|\bdone[!.]|✅|🟢|\bfully implemented\b|\bworking as expected\b|\bship it\b)'

claim_tests=0;     matches "$last_text" "$tests_claim_re"     && claim_tests=1
claim_typecheck=0; matches "$last_text" "$typecheck_claim_re" && claim_typecheck=1
claim_lint=0;      matches "$last_text" "$lint_claim_re"      && claim_lint=1
claim_build=0;     matches "$last_text" "$build_claim_re"     && claim_build=1
claim_merge=0;     matches "$last_text" "$merge_claim_re"     && claim_merge=1
claim_generic=0;   matches "$last_text" "$generic_claim_re"   && claim_generic=1

claim_any_specific=$(( claim_tests + claim_typecheck + claim_lint + claim_build + claim_merge ))
log "claims: tests=$claim_tests typecheck=$claim_typecheck lint=$claim_lint build=$claim_build merge=$claim_merge generic=$claim_generic"

# Nothing to enforce.
if [ "$claim_any_specific" = "0" ] && [ "$claim_generic" = "0" ]; then
  exit 0
fi

# ----- Recent Bash runs from transcript ----------------------------------
# Bound the read to the last 1500 transcript entries for speed.
recent_transcript=$(tail -n 1500 "$transcript_path" 2>/dev/null || true)

bash_uses=$(printf '%s' "$recent_transcript" | jq -s -c '
  [ .[]
    | select(.type == "assistant")
    | .message.content[]?
    | select(.type == "tool_use" and .name == "Bash")
    | { id: .id, cmd: (.input.command // "") }
  ] | (.[-150:] // .)
' 2>/dev/null || echo '[]')

bash_results=$(printf '%s' "$recent_transcript" | jq -s -c '
  [ .[]
    | select(.type == "user")
    | .message.content[]?
    | select(.type == "tool_result")
    | { key: .tool_use_id, value: { error: (.is_error // false) } }
  ] | from_entries
' 2>/dev/null || echo '{}')

bash_runs=$(jq -n -c --argjson uses "$bash_uses" --argjson results "$bash_results" '
  $uses | map(. + ($results[.id] // { error: false }))
' 2>/dev/null || echo '[]')

# Did any recent Bash run match $1 (regex) and succeed (is_error == false)?
matched_success() {
  local pat="$1"
  printf '%s' "$bash_runs" | jq -e --arg p "$pat" '
    any(.[]; (.cmd | test($p; "i")) and (.error == false))
  ' >/dev/null 2>&1
}

# Command-family patterns. Generous; project-specific commands won't all match.
tests_cmd_re='\b(bun test|bun run (test|tests)|npm (run )?test|yarn (run )?test|pnpm (run )?test|deno test|jest|vitest|pytest|mocha|ava|cargo test|go test|just (run )?test|make test)\b'
typecheck_cmd_re='\b(tsc|bun (run )?(check-types|typecheck|type-check)|npm run (check-types|typecheck|type-check)|yarn (check-types|typecheck|type-check)|pnpm run (check-types|typecheck|type-check)|mypy|just (check|typecheck))\b'
lint_cmd_re='\b(biome (check|lint|format)|bun run (lint|check|format)|npm run (lint|check)|yarn (lint|check)|pnpm (lint|check)|eslint|ruff (check|format)|cargo clippy|cargo fmt)\b'
build_cmd_re='\b(bun run build|npm run build|yarn build|pnpm build|vite build|webpack|cargo build|go build|just build|make build|next build)\b'

# ----- Per-claim verification --------------------------------------------
issues=()

if [ "$claim_tests" = "1" ] && ! matched_success "$tests_cmd_re"; then
  issues+=("Tests claim — no successful test command found in this session's transcript. Run the project's test command (e.g. \`bun test\`, \`pytest\`, \`cargo test\`) and paste the output with exit code before claiming tests pass.")
fi

if [ "$claim_typecheck" = "1" ] && ! matched_success "$typecheck_cmd_re"; then
  issues+=("Typecheck claim — no successful typecheck command found. Run \`tsc --noEmit\`, \`bun run check-types\`, \`mypy\`, or equivalent, and paste the output.")
fi

if [ "$claim_lint" = "1" ] && ! matched_success "$lint_cmd_re"; then
  issues+=("Lint claim — no successful lint command found. Run \`biome check\`, \`eslint\`, \`ruff check\`, \`cargo clippy\`, or equivalent, and paste the output.")
fi

if [ "$claim_build" = "1" ] && ! matched_success "$build_cmd_re"; then
  issues+=("Build claim — no successful build command found. Run the build and paste output.")
fi

if [ "$claim_merge" = "1" ]; then
  if [ -n "$cwd" ] && [ -d "$cwd/.git" ]; then
    dirty=$(cd "$cwd" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ -n "$dirty" ] && [ "$dirty" != "0" ]; then
      issues+=("Merge-ready claim — working tree has $dirty uncommitted or untracked path(s). Run \`git status\` and commit (or stash) before claiming merge-ready.")
    fi
  fi
fi

# Generic claim with NO specific claim → fall back to v1 fenced-block rule.
if [ "$claim_generic" = "1" ] && [ "$claim_any_specific" = "0" ]; then
  fence_count=$(printf '%s' "$last_text" | grep -c '```' || true)
  skip_re='(verification (skipped|impossible|not possible)|could(n.?t| not) verify|no (build|test|runtime) available|cannot run (the )?(build|tests?|lint))'
  if [ "$fence_count" -lt 2 ] && ! matches "$last_text" "$skip_re"; then
    issues+=("Generic completion claim ('done', 'all green', 'tout vert', '✅'…) without specific evidence. Either paste a fenced code block with command + exit code + stdout tail + \`git diff --stat\`, OR state explicitly 'verification skipped because <reason>'.")
  fi
fi

log "issues: ${#issues[@]}"

if [ "${#issues[@]}" -eq 0 ]; then
  exit 0
fi

# ----- Emit block decision -----------------------------------------------
reason=$'You signaled completion, but the following claims lack evidence (per ~/.claude/CLAUDE.md §13):\n'
for i in "${issues[@]}"; do
  reason+=$'\n  • '"$i"
done
reason+=$'\n\nAddress each item then end the turn. To bypass for one session: `export CLAUDE_SKIP_VERIFY_HOOK=1`.'

jq -nc --arg r "$reason" '{decision: "block", reason: $r}'
exit 0
