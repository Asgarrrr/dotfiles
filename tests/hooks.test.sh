#!/usr/bin/env bash
# Feeds hook payloads to the Claude Code hooks and checks their decision.
# Run: just test
set -uo pipefail

hooks="$(cd "$(dirname "$0")/../.agents/claude/hooks" && pwd)"
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1"; fail=$((fail+1)); }

safety() {
  jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' \
    | CLAUDE_SKIP_SAFETY_HOOK=0 "$hooks/safety-pre-tool.sh"
}
expect_deny()  { [[ "$(safety "$1")" == *'"deny"'* ]] && ok "deny:  $1" || bad "deny:  $1"; }
expect_allow() { [[ -z "$(safety "$1")" ]]            && ok "allow: $1" || bad "allow: $1"; }

echo "safety-pre-tool.sh:"
expect_deny 'rm -rf build'
expect_deny 'rm -fr build'
expect_deny 'rm -Rf build'
expect_deny 'rm -fR build'
expect_deny 'rm -r -f build'
expect_deny 'rm -f -r build'
expect_deny 'rm --recursive --force build'
expect_deny 'rm -v -rf build'
expect_deny 'sudo rm -rf /tmp/x'
expect_deny 'sudo -E rm -rf /tmp/x'
expect_deny 'find . -name dist | xargs rm -rf'
expect_deny 'xargs -0 rm -rf < list'
expect_deny '/bin/rm -rf build'
expect_deny 'command rm -rf build'
expect_deny 'cd /tmp && rm -rf x'
expect_deny 'echo $(rm -rf x)'
expect_deny 'git push --force origin main'
expect_deny 'git reset --hard HEAD~1'
expect_allow 'rm -r build'
expect_allow 'rm -f build.log'
expect_allow 'rm build.log; ls -R; grep -f patterns file'
expect_allow 'git rm -r --cached dist'
expect_allow 'grep -rf patterns src'
expect_allow 'git push origin feat/custom-field-filters'
for c in 'rm -rf x' 'git reset --hard' 'git clean -fd' 'DROP TABLE users'; do
  [[ "$(safety "$c")" != *'§'* ]] && ok "no stale § citation: $c" || bad "no stale § citation: $c"
done

echo "verify-on-stop.sh:"
tmp="$(mktemp -d)"
git -C "$tmp" init -q main
git -C "$tmp/main" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$tmp/main" worktree add -q "$tmp/wt" -b wt
touch "$tmp/wt/dirty"
transcript="$tmp/transcript.jsonl"
jq -nc '{type:"assistant",message:{content:[{type:"text",text:"Ready to merge."}]}}' > "$transcript"
stop() {
  jq -nc --arg t "$transcript" --arg c "$1" '{transcript_path:$t,cwd:$c,stop_hook_active:false}' \
    | CLAUDE_SKIP_VERIFY_HOOK=0 "$hooks/verify-on-stop.sh"
}
out="$(stop "$tmp/wt")"
[[ "$out" == *'"block"'* && "$out" == *'uncommitted'* ]] && ok "blocks merge-ready claim on a dirty worktree" || bad "blocks merge-ready claim on a dirty worktree"
touch "$tmp/main/dirty"
out="$(stop "$tmp/main")"
[[ "$out" == *'"block"'* ]] && ok "blocks merge-ready claim on a dirty main checkout" || bad "blocks merge-ready claim on a dirty main checkout"
[[ "$out" != *'§'* ]] && ok "no stale § citation" || bad "no stale § citation"
git -C "$tmp/main" worktree remove --force "$tmp/wt"
trash "$tmp" 2>/dev/null || true

echo "—"
echo "passed: $pass  failed: $fail"
[[ $fail -eq 0 ]]
