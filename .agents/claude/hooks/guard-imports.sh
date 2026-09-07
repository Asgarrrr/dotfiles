#!/usr/bin/env bash
# PostToolUse Write|Edit — reject imports of packages that do not exist.
#
# A CLAUDE.md instruction was the rejected alternative: asking a model to check
# its own imports is self-assessment without an oracle. Measured on 2026-era
# models — self-minimization removes 2-13% of patch slop against an external
# oracle's 18-33%, and corrupts the patch 3.8-44.9% of the time
# (arXiv:2607.18161). That gap is model-dependent; re-measure it before moving
# this check back into a rule file.
#
# Design constraints, in priority order:
#   1. Fails OPEN. Network down, registry 5xx, jq missing, curl missing -> exit 0.
#      A gate that blocks real work when npm sneezes gets deleted within a week,
#      and then it protects nothing.
#   2. Costs nothing in the common case. Anything already in package.json or
#      node_modules is real by construction and never touches the network.
#   3. Bounded. At most MAX_LOOKUPS network calls, 3s each.

FILE=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -z "$FILE" ] || [ ! -f "$FILE" ] && exit 0

case "${FILE##*.}" in
  js | jsx | ts | tsx | mjs | cjs) ;;
  *) exit 0 ;;
esac

command -v curl >/dev/null 2>&1 || exit 0

MAX_LOOKUPS=10
CACHE_DIR="${HOME}/.claude/cache/import-guard"
CACHE="${CACHE_DIR}/resolved.txt"
mkdir -p "$CACHE_DIR" 2>/dev/null
touch "$CACHE" 2>/dev/null

# Bare specifiers only. Relative paths and node: builtins are not registry names.
# For `@scope/pkg/deep` keep `@scope/pkg`; for `pkg/deep` keep `pkg`.
specifiers=$(
  grep -ohE "(from|require\()[[:space:]]*['\"][^'\"]+['\"]" "$FILE" 2>/dev/null |
    sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/" |
    grep -vE "^(\.|/|node:|bun:)" |
    sed -E 's|^(@[^/]+/[^/]+).*|\1|; s|^([^@][^/]*).*|\1|' |
    sort -u
)
[ -z "$specifiers" ] && exit 0

# Nearest package.json and node_modules, walking up from the edited file.
dir=$(dirname "$FILE")
manifest=""
modules=""
while [ "$dir" != "/" ]; do
  [ -z "$manifest" ] && [ -f "$dir/package.json" ] && manifest="$dir/package.json"
  [ -z "$modules" ] && [ -d "$dir/node_modules" ] && modules="$dir/node_modules"
  dir=$(dirname "$dir")
done

missing=""
lookups=0

for pkg in $specifiers; do
  # Declared as a dependency, or installed on disk: real, no network needed.
  [ -n "$modules" ] && [ -e "$modules/$pkg" ] && continue
  if [ -n "$manifest" ] &&
    jq -e --arg p "$pkg" \
      '((.dependencies // {}) + (.devDependencies // {}) + (.peerDependencies // {}) + (.optionalDependencies // {})) | has($p)' \
      "$manifest" >/dev/null 2>&1; then
    continue
  fi

  grep -qxF "$pkg" "$CACHE" 2>/dev/null && continue

  [ "$lookups" -ge "$MAX_LOOKUPS" ] && break
  lookups=$((lookups + 1))

  # Scoped names must be URL-escaped for the npm registry: @a/b -> @a%2Fb
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 \
    "https://registry.npmjs.org/${pkg/\//%2F}" 2>/dev/null)

  case "$code" in
    200) printf '%s\n' "$pkg" >>"$CACHE" ;;
    404) missing="${missing} ${pkg}" ;;
    *) : ;; # 000 network failure, 5xx registry trouble -> fail open, say nothing
  esac
done

[ -z "$missing" ] && exit 0

for pkg in $missing; do
  printf 'Import "%s" in %s does not exist on the npm registry (HTTP 404).\n' \
    "$pkg" "$FILE" >&2
done
cat >&2 <<'EOF'

This is the hallucinated-package failure mode, and the name may be registered by
someone else tomorrow. Do not add it to package.json to make this pass. Find the
real package name, or drop the import.
EOF
exit 2
