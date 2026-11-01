#!/bin/bash
# Detects stack signals in a project (package.json deps, config files, code
# patterns) and switches the matching skills on in the project's
# .claude/settings.local.json. Stack skills are off globally via skillOverrides
# in settings.json; the project-level "on" wins over the user-level "off".
# Usage: suggest-skills.sh [project-dir] [--yes]
#   --yes / -y : enable without prompting (non-interactive use, e.g. from the
#                /suggest-skills command)
set -euo pipefail

YES=0
PROJECT_ARG="."
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    *) PROJECT_ARG="$arg" ;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_ARG" && pwd)"
SETTINGS="$PROJECT_DIR/.claude/settings.local.json"

has_dep() {
  [ -f "$PROJECT_DIR/package.json" ] && grep -q "\"$1" "$PROJECT_DIR/package.json"
}

has_file() {
  [ -e "$PROJECT_DIR/$1" ]
}

grep_src() {
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
  echo "No stack signals detected in $PROJECT_DIR — nothing to suggest."
  exit 0
fi

IFS=$'\n' unique=($(printf '%s\n' "${matched[@]}" | sort -u)); unset IFS

is_on() {
  [ -f "$SETTINGS" ] && [ "$(jq -r --arg n "$1" '.skillOverrides[$n] // empty' "$SETTINGS")" = "on" ]
}

# Drop anything already enabled — only show/confirm genuinely new suggestions.
new=()
for name in "${unique[@]}"; do
  is_on "$name" || new+=("$name")
done

if [ "${#new[@]}" -eq 0 ]; then
  echo "All detected skills are already enabled in $PROJECT_DIR."
  exit 0
fi

echo "Detected signals suggest enabling:"
printf '  - %s\n' "${new[@]}"
echo

if [ "$YES" -eq 1 ]; then
  ans=y
else
  read -r -p "Enable these in $SETTINGS ? [y/N] " ans || ans=n
fi

if [[ "$ans" =~ ^[Yy]$ ]]; then
  mkdir -p "$PROJECT_DIR/.claude"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  tmp="$(mktemp)"
  jq --args '.skillOverrides += ($ARGS.positional | map({(.): "on"}) | add)' "${new[@]}" < "$SETTINGS" > "$tmp"
  mv "$tmp" "$SETTINGS"
  echo "Enabled in $SETTINGS (new Claude Code session needed to see them)"
else
  echo "Skipped."
fi
