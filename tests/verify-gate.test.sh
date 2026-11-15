#!/usr/bin/env bash
# Feeds PreToolUse, UserPromptSubmit and Stop payloads to verify-gate.sh against scratch repos.
# Run: just test (or bash tests/verify-gate.test.sh)
set -uo pipefail

hook="$(cd "$(dirname "$0")/../.agents/claude/hooks" && pwd)/verify-gate.sh"
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1"; fail=$((fail+1)); }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export VERIFY_GATE_STATE="$tmp/state"
commit() { git -C "$1" add -A >/dev/null && git -C "$1" -c user.email=t@t -c user.name=t commit -qm "$2"; }

# The verify script counts its runs, fails while the repo holds FAIL, and sleeps while it holds SLOW.
new_repo() {
  git init -q "$1"
  mkdir -p "$1/scripts"
  cat > "$1/scripts/verify" <<'EOF'
#!/usr/bin/env bash
root="$(dirname "$0")/.."
echo run >> "$root/.verify-runs"
[ -e "$root/SLOW" ] && (sleep 2; touch "$root/LATE") && sleep 30
if [ -e "$root/FAIL" ]; then echo "verify: boom"; exit 1; fi
echo "verify: ok"
EOF
  chmod +x "$1/scripts/verify"
  printf '.verify-runs\n' > "$1/.gitignore"
}
repo="$tmp/repo"
new_repo "$repo"
commit "$repo" init

runs() { [ -f "${1:-$repo}/.verify-runs" ] && wc -l < "${1:-$repo}/.verify-runs" | tr -d ' ' || echo 0; }
tool()   { jq -nc --arg s "$1" --arg c "${2:-$repo}" '{hook_event_name:"PreToolUse",session_id:$s,cwd:$c,tool_name:"Edit"}' | "$hook"; }
prompt() { jq -nc --arg s "$1" --arg c "${2:-$repo}" '{hook_event_name:"UserPromptSubmit",session_id:$s,cwd:$c,prompt:"x"}' | "$hook"; }
stop()   { jq -nc --arg s "$1" --arg c "${2:-$repo}" --argjson b "${3:-[]}" '{hook_event_name:"Stop",session_id:$s,cwd:$c,stop_hook_active:false,background_tasks:$b}' | "$hook"; }
blocks() { [[ "$1" == *'"decision":"block"'* ]]; }
blockers="$repo/.git/BLOCKERS.md"

echo "verify-gate.sh:"

out="$(stop s0 "$tmp")"
[ -z "$out" ] && ok "outside a git repo: silent" || bad "outside a git repo: silent ($out)"

other="$tmp/other"; git init -q "$other"; touch "$other/x"
out="$(tool s0 "$other"; stop s0 "$other")"
[ -z "$out" ] && ok "repo without scripts/verify: silent" || bad "repo without scripts/verify: silent ($out)"

tool s1
out="$(stop s1)"
[ -z "$out" ] && [ "$(runs)" = 0 ] && ok "no change since the first tool call: verify not run" || bad "no change since the first tool call (runs=$(runs))"

echo a > "$repo/a.txt"
out="$(stop s1)"
[ -z "$out" ] && [ "$(runs)" = 1 ] && ok "change + verify passes: allowed, verify ran once" || bad "change + verify passes (runs=$(runs), out=$out)"

out="$(stop s1)"
[ -z "$out" ] && [ "$(runs)" = 1 ] && ok "same state after a pass: verify not rerun" || bad "same state after a pass (runs=$(runs))"

echo b >> "$repo/a.txt"
out="$(stop s1 "$repo" '[{"id":"t","type":"subagent","status":"running"}]')"
[ -z "$out" ] && [ "$(runs)" = 1 ] && ok "background subagent running: gate deferred" || bad "background subagent running: gate deferred (runs=$(runs))"
out="$(stop s1 "$repo" '[{"id":"t","type":"shell","status":"running","command":"npm run dev"}]')"
[ -z "$out" ] && [ "$(runs)" = 2 ] && ok "background shell running: gate still runs" || bad "background shell running: gate still runs (runs=$(runs))"

touch "$repo/FAIL"
out="$(stop s1)"
blocks "$out" && [[ "$out" == *'verify: boom'* ]] && [[ "$out" == *'1/4'* ]] && ok "verify fails: block with log tail and attempt 1/4" || bad "verify fails: block with log tail ($out)"
before=$(runs)
out="$(stop s1)"
blocks "$out" && [[ "$out" == *'2/4'* ]] && [[ "$out" == *'verify: boom'* ]] && [ "$(runs)" = "$before" ] && ok "same failing state: counts 2/4 from the cached log, no rerun" || bad "same failing state: cached (runs=$(runs), out=$out)"

prompt s1
out="$(stop s1)"
blocks "$out" && [[ "$out" == *'1/4'* ]] && ok "a user prompt resets the counter" || bad "a user prompt resets the counter ($out)"

mv "$repo/FAIL" "$tmp/FAIL.held"; stop s1 >/dev/null
mv "$tmp/FAIL.held" "$repo/FAIL"
out="$(stop s1)"
blocks "$out" && [[ "$out" == *'1/4'* ]] && ok "a passing state between failures resets the counter" || bad "a passing state between failures resets the counter ($out)"

commit "$repo" wip
rm "$repo/FAIL"; echo fixed >> "$repo/a.txt"; commit "$repo" fix
before=$(runs)
out="$(stop s1)"
[ -z "$out" ] && [ "$(runs)" = $((before+1)) ] && ok "committed fix, clean tree: verify reruns and passes" || bad "committed fix, clean tree (out=$out)"

touch "$repo/FAIL"
before=$(runs)
for i in 1 2 3; do out="$(stop s1)"; done
blocks "$out" && [[ "$out" == *'3/4'* ]] && [ "$(runs)" = $((before+1)) ] && ok "third stop on one failing state: 3/4, verify ran once" || bad "third stop on one failing state (runs=$(runs), out=$out)"
out="$(stop s1)"
! blocks "$out" && [[ "$out" == *"$blockers"* ]] && grep -q 'verify: boom' "$blockers" 2>/dev/null && ok "fourth failure: allowed, log in .git/BLOCKERS.md" || bad "fourth failure: BLOCKERS.md ($out)"
[ -z "$(git -C "$repo" status --porcelain | grep -i blockers)" ] && ok "BLOCKERS.md stays out of the working tree" || bad "BLOCKERS.md stays out of the working tree"
before=$(runs)
out="$(stop s1)"
[ -z "$out" ] && [ "$(runs)" = "$before" ] && ok "same failing state after BLOCKERS.md: no block, no rerun" || bad "same failing state after BLOCKERS.md (out=$out)"

echo c >> "$repo/a.txt"
out="$(stop s1)"
blocks "$out" && [[ "$out" == *'1/4'* ]] && ok "new change after a blocker: counter restarts at 1/4" || bad "new change after a blocker ($out)"

before=$(runs)
out="$(stop s2)"
[ -z "$out" ] && [ "$(runs)" = "$before" ] && ok "session with no tool call in the repo: not gated" || bad "session with no tool call in the repo ($out)"
echo d >> "$repo/a.txt"
out="$(stop s2)"
blocks "$out" && ok "same session after a change: gated" || bad "same session after a change ($out)"
rm "$repo/FAIL"

wt="$tmp/wt"
git -C "$repo" worktree add -q "$wt" -b wt
tool s3 "$wt"
touch "$wt/FAIL"; commit "$wt" "break in a worktree"
out="$(stop s3 "$wt")"
blocks "$out" && ok "worktree: a committed, clean breaking change is gated" || bad "worktree: committed breaking change ($out)"

tool s4
ln -s /nonexistent "$repo/aa-broken"; ln -s "$tmp" "$repo/ab-dir"; echo 1 > "$repo/zz.txt"
stop s4 >/dev/null
before=$(runs)
echo 2 > "$repo/zz.txt"
stop s4 >/dev/null
[ "$(runs)" = $((before+1)) ] && ok "untracked symlinks: later untracked edits still change the state" || bad "untracked symlinks (runs=$(runs), before=$before)"

unborn="$tmp/unborn"
new_repo "$unborn"; echo x > "$unborn/src.txt"; git -C "$unborn" add -A
tool s5 "$unborn"
echo y > "$unborn/src.txt"
stop s5 "$unborn" >/dev/null
before=$(runs "$unborn")
echo z > "$unborn/src.txt"
stop s5 "$unborn" >/dev/null
[ "$(runs "$unborn")" = $((before+1)) ] && ok "unborn HEAD: edits to a staged file change the state" || bad "unborn HEAD (runs=$(runs "$unborn"), before=$before)"

slow="$tmp/slow"
new_repo "$slow"; commit "$slow" init
tool s6 "$slow"
touch "$slow/SLOW"
start=$SECONDS
out="$(VERIFY_GATE_TIMEOUT=1 stop s6 "$slow")"
blocks "$out" && [[ "$out" == *'exceeded 1 s'* ]] && (( SECONDS - start < 10 )) && sleep 3 && [ ! -e "$slow/LATE" ] && ok "verify past VERIFY_GATE_TIMEOUT: its whole process group killed, counted as a failure" || bad "verify timeout ($out, $((SECONDS - start)) s)"

out="$(printf 'not json' | "$hook")"; rc=$?
[ "$rc" = 0 ] && [ -z "$out" ] && ok "malformed input: fail open" || bad "malformed input: fail open (rc=$rc)"

echo "verify-gate: $pass passed, $fail failed"
[ "$fail" = 0 ]
