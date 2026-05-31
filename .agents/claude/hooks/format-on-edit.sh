#!/usr/bin/env bash
FILE=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -z "$FILE" ] || [ ! -f "$FILE" ] && exit 0

case "$(basename "$FILE")" in
  bun.lockb|package-lock.json|yarn.lock|pnpm-lock.yaml|*.min.js|*.min.css|.env|.env.*)
    exit 0 ;;
esac

EXT="${FILE##*.}"

find_local_bin() {
  local dir
  dir="$(dirname "$1")"
  while [ "$dir" != "/" ]; do
    [ -x "$dir/node_modules/.bin/$2" ] && echo "$dir/node_modules/.bin/$2" && return 0
    dir="$(dirname "$dir")"
  done
  command -v "$2" 2>/dev/null
}

find_biome_config() {
  local dir
  dir="$(dirname "$1")"
  while [ "$dir" != "/" ]; do
    { [ -f "$dir/biome.json" ] || [ -f "$dir/biome.jsonc" ]; } && return 0
    dir="$(dirname "$dir")"
  done
  return 1
}

case "$EXT" in
  js|jsx|ts|tsx|css|scss|json|html|md|yaml|yml|graphql)
    PRETTIER=$(find_local_bin "$FILE" prettier 2>/dev/null)
    BIOME=$(find_local_bin "$FILE" biome 2>/dev/null)
    if [ -n "$PRETTIER" ]; then
      "$PRETTIER" --write "$FILE" 2>/dev/null
    elif [ -n "$BIOME" ] && find_biome_config "$FILE"; then
      "$BIOME" format --write "$FILE" 2>/dev/null
    fi
    ;;
  py)
    if command -v ruff &>/dev/null; then ruff format "$FILE" 2>/dev/null
    elif command -v black &>/dev/null; then black "$FILE" 2>/dev/null
    fi
    ;;
  go)
    command -v gofmt &>/dev/null && gofmt -w "$FILE" 2>/dev/null
    ;;
  rs)
    command -v rustfmt &>/dev/null && rustfmt "$FILE" 2>/dev/null
    ;;
esac
exit 0
