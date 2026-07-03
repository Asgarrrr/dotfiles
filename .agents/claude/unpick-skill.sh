#!/bin/bash
# Removes a project-scoped skill symlink previously created by pick-skill.sh.
# Usage: unpick-skill.sh <skill-name> [project-dir]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: unpick-skill.sh <skill-name> [project-dir]" >&2
  exit 1
fi

NAME="$1"
PROJECT_DIR="$(cd "${2:-.}" && pwd)"
TARGET="$PROJECT_DIR/.claude/skills/$NAME"

if [ ! -L "$TARGET" ]; then
  echo "$TARGET is not a symlink (not managed by pick-skill.sh) — leaving it alone." >&2
  exit 1
fi

rm "$TARGET"
echo "Removed $NAME from $PROJECT_DIR/.claude/skills/"
