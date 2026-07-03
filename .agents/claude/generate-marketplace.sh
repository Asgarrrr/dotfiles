#!/bin/bash
# Regenerates ../../.claude-plugin/marketplace.json from the plugins/*/ directories.
# Run this after adding, removing, or renaming a plugin under .agents/claude/plugins/,
# then commit the result — Claude Code resolves plugin sources from the git tree.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGINS_DIR="$SCRIPT_DIR/plugins"
OUT="$REPO_ROOT/.claude-plugin/marketplace.json"

names=()
if [ -d "$PLUGINS_DIR" ]; then
  for dir in "$PLUGINS_DIR"/*/; do
    [ -f "$dir/.claude-plugin/plugin.json" ] || continue
    names+=("$(basename "$dir")")
  done
fi

filter='{
  name: "dotfiles-skills",
  owner: { name: "Asgarrrr" },
  plugins: [ $ARGS.positional[] | { name: ., source: ("./.agents/claude/plugins/" + .) } ]
}'

if [ "${#names[@]}" -eq 0 ]; then
  jq -n "$filter" --args > "$OUT"
else
  jq -n "$filter" --args "${names[@]}" > "$OUT"
fi

echo "wrote $OUT (${#names[@]} plugins)"
