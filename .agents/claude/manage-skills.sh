#!/bin/bash
# Interactive checklist (via fzf) to pick which pool skills are enabled for a
# project. TAB toggles, ENTER confirms; reconciles .claude/skills/ symlinks
# by calling pick-skill.sh / unpick-skill.sh under the hood.
# Usage: manage-skills.sh [project-dir]
set -euo pipefail

command -v fzf >/dev/null || { echo "fzf is required: brew install fzf" >&2; exit 1; }

PROJECT_DIR="$(cd "${1:-.}" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POOL="$SCRIPT_DIR/../skills"
LINKS_DIR="$PROJECT_DIR/.claude/skills"

mkdir -p "$LINKS_DIR"

names=()
for dir in "$POOL"/*/; do
  names+=("$(basename "$dir")")
done
IFS=$'\n' names=($(printf '%s\n' "${names[@]}" | sort)); unset IFS

lines=()
for name in "${names[@]}"; do
  if [ -L "$LINKS_DIR/$name" ]; then
    lines+=("[x] $name")
  else
    lines+=("[ ] $name")
  fi
done

selection="$(printf '%s\n' "${lines[@]}" | fzf --multi \
  --header 'TAB toggle, ENTER confirm — re-tick [x] items to keep them enabled' \
  | sed 's/^\[.\] //')" || true

chosen=()
if [ -n "$selection" ]; then
  IFS=$'\n' chosen=($selection); unset IFS
fi

changed=0
for name in "${names[@]}"; do
  want=0
  for c in ${chosen[@]+"${chosen[@]}"}; do [ "$c" = "$name" ] && want=1; done
  have=0
  [ -L "$LINKS_DIR/$name" ] && have=1

  if [ "$want" -eq 1 ] && [ "$have" -eq 0 ]; then
    "$SCRIPT_DIR/pick-skill.sh" "$name" "$PROJECT_DIR" >/dev/null
    echo "+ $name"
    changed=1
  elif [ "$want" -eq 0 ] && [ "$have" -eq 1 ]; then
    "$SCRIPT_DIR/unpick-skill.sh" "$name" "$PROJECT_DIR" >/dev/null
    echo "- $name"
    changed=1
  fi
done

if [ "$changed" -eq 0 ]; then
  echo "No changes."
else
  echo "Done — new Claude Code session needed to see changes."
fi
