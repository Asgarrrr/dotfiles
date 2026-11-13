#!/usr/bin/env bash
# PreToolUse + UserPromptSubmit + Stop hook: a repo that ships an executable
# scripts/verify cannot end a turn with changes that fail it. Repos without
# scripts/verify are untouched.
#
# The first tool call of a session in a repo records its state, so a worktree or
# a repo reached by cd gets its own baseline. At Stop, the gate runs
# scripts/verify only when the state differs from that baseline and from the
# last passing state. A failure blocks the stop with the log tail. After
# VERIFY_GATE_MAX failures in one turn the hook appends the log to BLOCKERS.md in
# the git common dir and lets the turn end, so a wrong criterion cannot trap the
# agent. A user prompt starts a new turn and resets the count.
#
# The gate defers while a subagent, workflow or teammate runs: their edits are
# not finished. Fail-open: an error in the hook itself never blocks.

set -uo pipefail

state_dir="${VERIFY_GATE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/claude-verify-gate}"
max="${VERIFY_GATE_MAX:-4}"
limit="${VERIFY_GATE_TIMEOUT:-1500}"

input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
event=$(jq -r '.hook_event_name // empty' <<< "$input" 2>/dev/null) || exit 0
session=$(jq -r '.session_id // empty' <<< "$input" 2>/dev/null) || exit 0
cwd=$(jq -r '.cwd // empty' <<< "$input" 2>/dev/null) || exit 0
[ -n "$event" ] && [ -n "$session" ] && [ -d "$cwd" ] || exit 0

root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
verify="$root/scripts/verify"
[ -x "$verify" ] || exit 0

mkdir -p "$state_dir" 2>/dev/null || exit 0
id=$(printf '%s\n%s' "$session" "$root" | shasum | cut -c1-16)
sfile() { echo "$state_dir/$id.$1"; }

# The tree git would commit for the whole working tree, untracked files included,
# built in a scratch index so the real index is never touched.
state_key() {
  local index
  index=$(mktemp "$state_dir/index.XXXXXX") || return 1
  (
    cd "$root" || exit 1
    cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || rm -f "$index"
    GIT_INDEX_FILE="$index" git add -A . >/dev/null 2>&1 &&
      GIT_INDEX_FILE="$index" git write-tree 2>/dev/null
  )
  local rc=$?
  rm -f "$index"
  return $rc
}

case "$event" in
  UserPromptSubmit)
    rm -f "$(sfile fails)"
    exit 0
    ;;
  PreToolUse)
    [ -f "$(sfile start)" ] && exit 0
    key=$(state_key) && echo "$key" > "$(sfile start)"
    exit 0
    ;;
  Stop) ;;
  *) exit 0 ;;
esac

editors=$(jq -r '[(.background_tasks // [])[] | select(.type == "subagent" or .type == "workflow" or .type == "teammate")] | length' <<< "$input" 2>/dev/null || echo 0)
[ "$editors" = 0 ] || exit 0

key=$(state_key) || exit 0
if [ ! -f "$(sfile start)" ]; then
  # No tool ran in this repo yet: nothing this session did can be at fault.
  echo "$key" > "$(sfile start)"
  exit 0
fi
if [ "$key" = "$(cat "$(sfile start)")" ] || { [ -f "$(sfile pass)" ] && [ "$key" = "$(cat "$(sfile pass)")" ]; }; then
  rm -f "$(sfile fails)"
  exit 0
fi
[ -f "$(sfile blocked)" ] && [ "$key" = "$(cat "$(sfile blocked)")" ] && exit 0

log="$state_dir/$id.log"
if ! { [ -f "$(sfile failed)" ] && [ "$key" = "$(cat "$(sfile failed)")" ]; }; then
  # Own process group, so a timeout kills cargo and the other children too.
  (cd "$root" && perl -e '
    my $t = shift; my $pid = fork // exit 1;
    if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
    local $SIG{ALRM} = sub { kill "KILL", -$pid; waitpid $pid, 0; exit 124 };
    alarm $t; waitpid $pid, 0; exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
  ' "$limit" "$verify") > "$log" 2>&1
  rc=$?
  if [ "$rc" = 0 ]; then
    echo "$key" > "$(sfile pass)"
    rm -f "$(sfile fails)" "$(sfile failed)"
    exit 0
  fi
  [ "$rc" = 124 ] && echo "verify-gate: scripts/verify exceeded $limit s and was killed" >> "$log"
  echo "$key" > "$(sfile failed)"
fi

fails=$(( $(cat "$(sfile fails)" 2>/dev/null || echo 0) + 1 ))
tail_text=$(tail -n 60 "$log" | cut -c1-200)

if [ "$fails" -ge "$max" ]; then
  blockers="$(cd "$root" && cd "$(git rev-parse --git-common-dir)" && pwd)/BLOCKERS.md"
  {
    printf '\n## %s: scripts/verify failed %s times in a row\n\n' "$(date '+%Y-%m-%d %H:%M')" "$fails"
    printf 'Worktree `%s`, branch `%s`, HEAD `%s`. Last 60 lines:\n\n```\n%s\n```\n' "$root" \
      "$(git -C "$root" branch --show-current 2>/dev/null)" \
      "$(git -C "$root" rev-parse --short HEAD 2>/dev/null)" "$tail_text"
  } >> "$blockers"
  echo "$key" > "$(sfile blocked)"
  rm -f "$(sfile fails)"
  jq -nc --arg m "verify-gate: scripts/verify failed $fails times; log appended to $blockers" '{systemMessage:$m}'
  exit 0
fi

echo "$fails" > "$(sfile fails)"
reason="scripts/verify failed (attempt $fails/$max). Fix the cause in the code. Never edit scripts/verify, tests or their fixtures to make it pass; if a criterion itself looks wrong, say so and stop changing code. Last lines:
$tail_text"
jq -nc --arg r "${reason:0:9000}" '{decision:"block",reason:$r}'
exit 0
