#!/usr/bin/env bash
# PreCompact: write a session digest to memory before context is compressed.
# Survives compaction so the next context window has decision history.

set -uo pipefail

input=$(cat)
trigger=$(printf '%s' "$input" | jq -r '.trigger // "unknown"' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
[ -z "$cwd" ] && exit 0

# Derive project memory path (same convention as auto-memory system)
encoded=$(printf '%s' "$cwd" | tr '/' '-' | sed 's/^-//')
memory_dir="$HOME/.claude/projects/$encoded/memory"
mkdir -p "$memory_dir"

digest_file="$memory_dir/session-digest-$(date +%Y%m%d-%H%M%S).md"

# Collect recent file edits from transcript if available
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)

recent_files=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  recent_files=$(tail -n 500 "$transcript_path" 2>/dev/null \
    | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and (.name=="Write" or .name=="Edit")) | .input.file_path // empty' 2>/dev/null \
    | sort -u | head -20 | sed 's/^/- /' || true)
fi

cat > "$digest_file" <<EOF
---
name: session-digest-$(date +%Y%m%d-%H%M%S)
description: Auto-saved session state before context compaction (trigger: $trigger)
metadata:
  type: project
---

**Compaction digest** — $(date '+%Y-%m-%d %H:%M')
**Trigger:** $trigger
**CWD:** $cwd

**Files touched this session:**
${recent_files:-"(unavailable)"}

**Why:** Auto-saved by precompact hook before context compression. Review and prune if stale.
**How to apply:** Use as starting context for the next phase of this work.
EOF

exit 0
