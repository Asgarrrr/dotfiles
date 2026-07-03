#!/bin/bash
# Symlinks a skill from the dotfiles pool into a project's .claude/skills/,
# so it's available in that project only (project-scoped skills apply just
# to the project they live in — no marketplace, no plugin, no registration).
# Usage: pick-skill.sh <skill-name> [project-dir]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: pick-skill.sh <skill-name> [project-dir]" >&2
  exit 1
fi

NAME="$1"
PROJECT_DIR="$(cd "${2:-.}" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POOL="$SCRIPT_DIR/../skills/$NAME"

if [ ! -d "$POOL" ]; then
  echo "No such skill in the pool: $NAME" >&2
  echo "Available skills:" >&2
  ls "$SCRIPT_DIR/../skills" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/.claude/skills"
DEST="$PROJECT_DIR/.claude/skills/$NAME"

if [ -e "$DEST" ]; then
  echo "$DEST already exists — skipping."
  exit 0
fi

ln -s "$(cd "$POOL" && pwd)" "$DEST"
echo "Linked $NAME into $PROJECT_DIR/.claude/skills/ (new Claude Code session needed to see it)"
