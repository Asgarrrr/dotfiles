#!/bin/bash
# Scans a project for stack signals (package.json deps, config files, API calls)
# and suggests which dotfiles-skills plugins to enable there, then optionally
# writes .claude/settings.json for you — so you never have to remember plugin names.
# Usage: suggest-plugins.sh [project-dir]
set -euo pipefail

PROJECT_DIR="$(cd "${1:-.}" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MARKETPLACE="$REPO_ROOT/.claude-plugin/marketplace.json"
SETTINGS="$PROJECT_DIR/.claude/settings.json"

has_dep() {
  # $1 = substring to grep for in package.json (dependency name)
  [ -f "$PROJECT_DIR/package.json" ] && grep -q "\"$1" "$PROJECT_DIR/package.json"
}

has_file() {
  [ -e "$PROJECT_DIR/$1" ]
}

grep_src() {
  # $1 = pattern to grep for across source files, excluding build/vendor dirs
  grep -rq "$1" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist \
    "$PROJECT_DIR" 2>/dev/null
}

matched=()
add() { matched+=("$1"); }

has_file wrangler.toml && { add cloudflare; add wrangler; add workers-best-practices; }
has_dep "@cloudflare/sandbox" && add sandbox-sdk
has_dep "agents" && has_file wrangler.toml && add agents-sdk
has_dep "better-auth" && {
  add better-auth-best-practices
  add better-auth-security-best-practices
  add create-auth-skill
  add email-and-password-best-practices
}
grep_src "twoFactor(" && add two-factor-authentication-best-practices
grep_src "organization(" && add organization-best-practices
has_dep "turnstile" && add turnstile-spin
has_file railway.json && add use-railway
has_file vercel.json && {
  add vercel-composition-patterns
  add vercel-react-best-practices
  add vercel-react-view-transitions
}
has_file components.json && add shadcn
has_file wrangler.toml && grep -q "durable_objects" "$PROJECT_DIR/wrangler.toml" 2>/dev/null && add durable-objects
grep_src "cloudflareOne\|zeroTrust\|access\.application" && { add cloudflare-one; add cloudflare-one-migrations; }

if [ "${#matched[@]}" -eq 0 ]; then
  echo "No stack signals detected in $PROJECT_DIR — no plugins suggested."
  exit 0
fi

IFS=$'\n' read -r -d '' -a unique < <(printf '%s\n' "${matched[@]}" | sort -u && printf '\0') || true

echo "Detected signals suggest enabling:"
printf '  - %s\n' "${unique[@]}"
echo

read -r -p "Write $SETTINGS ? [y/N] " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
  mkdir -p "$PROJECT_DIR/.claude"
  filter='{ enabledPlugins: ( [ $ARGS.positional[] | { (. + "@dotfiles-skills"): true } ] | add ) }'
  jq -n "$filter" --args "${unique[@]}" > "$SETTINGS"
  echo "wrote $SETTINGS"
else
  echo "Skipped."
fi
