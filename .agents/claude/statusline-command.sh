#!/usr/bin/env bash
# Claude Code status line — Vesper palette

input=$(cat)

# --- Data extraction ---
model=$(echo "$input" | jq -r '.model.display_name // "Claude"')
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')

ctx_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
five_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_reset=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
week_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
week_reset=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')
effort=$(echo "$input" | jq -r '.effort.level // empty')
thinking=$(echo "$input" | jq -r '.thinking.enabled // empty')

# Share of the last response's input served from cache. current_usage is null
# before the first API call and right after /compact, so empty means "unknown"
# rather than zero.
cache_pct=$(echo "$input" | jq -r '
  (.context_window.current_usage // {}) as $u
  | (($u.input_tokens // 0) + ($u.cache_creation_input_tokens // 0) + ($u.cache_read_input_tokens // 0)) as $total
  | if $total > 0 then (($u.cache_read_input_tokens // 0) * 100 / $total) else empty end
')

transcript=$(echo "$input" | jq -r '.transcript_path // empty')

dir=$(basename "$cwd")

# --- Git info ---
branch=""
dirty_count=0
diff_added=0
diff_removed=0
if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
  dirty_count=$(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null | grep -c '[^ ]' || true)
  if [ "$dirty_count" -gt 0 ]; then
    diff_added=$(git -C "$cwd" --no-optional-locks diff HEAD --numstat 2>/dev/null | awk '{sum+=$1} END{print sum+0}')
    diff_removed=$(git -C "$cwd" --no-optional-locks diff HEAD --numstat 2>/dev/null | awk '{sum+=$2} END{print sum+0}')
  fi
fi

# --- Vesper palette ---
ACCENT='\033[38;2;255;199;153m'
MUTED='\033[38;2;161;161;170m'
SUBTLE='\033[38;2;107;107;120m'
RED='\033[38;2;255;128;128m'
GREEN='\033[38;2;148;210;189m'
RESET='\033[0m'

# --- Helpers ---
join_parts() {
  local sep result=""
  sep="$(printf "${SUBTLE} · ${RESET}")"
  for part in "$@"; do
    [ -z "$result" ] && result="$part" || result="${result}${sep}${part}"
  done
  printf '%s' "$result"
}

fmt_eta() {
  local s=$1 d h m
  d=$((s / 86400)); h=$(((s % 86400) / 3600)); m=$(((s % 3600) / 60))
  if [ "$d" -gt 0 ]; then printf '%dd%dh' "$d" "$h"
  elif [ "$h" -gt 0 ]; then printf '%dh%02dm' "$h" "$m"
  else printf '%dm' "$m"; fi
}

# Burn rate vs share of the window already elapsed: ahead of budget means the
# quota runs out before the reset, behind means there is headroom left.
pace_arrow() {
  local used=$1 window=$2 remaining=$3 elapsed diff
  [ "$remaining" -le 0 ] || [ "$remaining" -ge "$window" ] && return
  elapsed=$(( (window - remaining) * 100 / window ))
  [ "$elapsed" -lt 5 ] && return
  diff=$((used - elapsed))
  # Leading space lives here so the no-arrow case leaves no trailing blank.
  if [ "$diff" -gt 5 ]; then printf " ${RED}↗${RESET}"
  elif [ "$diff" -lt -5 ]; then printf " ${GREEN}↘${RESET}"
  else printf " ${SUBTLE}→${RESET}"; fi
}

# Segment "5h[2h09m] 42% ↗" — window, time left before it resets, usage, pace.
rate_segment() {
  local label=$1 window=$2 used=$3 reset_at=$4 color remaining eta=""
  if [ "$used" -ge 80 ]; then color="$RED"
  elif [ "$used" -ge 50 ]; then color="$ACCENT"
  else color="$SUBTLE"; fi
  if [ -n "$reset_at" ]; then
    remaining=$(( $(printf '%.0f' "$reset_at") - now ))
    [ "$remaining" -gt 0 ] && eta="$(printf "${SUBTLE}[%s]${RESET}" "$(fmt_eta "$remaining")")"
  fi
  printf "${color}%s${RESET}%s ${color}%d%%${RESET}%s" \
    "$label" "$eta" "$used" "$(pace_arrow "$used" "$window" "${remaining:-0}")"
}

now=$(date +%s)

# Cache expiry is not in the payload, so it is derived from the transcript: the
# last assistant turn's timestamp plus the TTL of the bucket it wrote to. Every
# turn that touches the cache pushes the deadline back, so this reads as "expires
# in X if nothing else happens". Only the tail is parsed — the transcript grows
# without bound and this runs on every refresh.
cache_eta=""
if [ -n "$transcript" ] && [ -r "$transcript" ]; then
  last_turn=$(tail -n 200 "$transcript" 2>/dev/null | jq -rc --slurp '
    map(select(.type=="assistant" and .message.usage != null)) | last
    | select(. != null)
    | [.timestamp,
       (if (.message.usage.cache_creation.ephemeral_1h_input_tokens // 0) > 0
        then 3600 else 300 end)]
    | @tsv
  ' 2>/dev/null)
  if [ -n "$last_turn" ]; then
    last_ts=${last_turn%%$'\t'*}
    cache_ttl=${last_turn##*$'\t'}
    last_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%S" "${last_ts%%.*}" +%s 2>/dev/null)
    if [ -n "$last_epoch" ]; then
      cache_left=$(( last_epoch + cache_ttl - now ))
      [ "$cache_left" -gt 0 ] && cache_eta=$(fmt_eta "$cache_left")
    fi
  fi
fi


# --- Line 1 left: ctx · rate limits ---
l1_left=()

if [ -n "$ctx_pct" ]; then
  ctx_int=$(printf '%.0f' "$ctx_pct")
  if [ "$ctx_int" -ge 80 ]; then ctx_color="$RED"
  elif [ "$ctx_int" -ge 50 ]; then ctx_color="$ACCENT"
  else ctx_color="$SUBTLE"; fi
  l1_left+=("$(printf "${ctx_color}ctx %d%%${RESET}" "$ctx_int")")
fi

# Unlike the other meters, a high number is the good outcome here, so the
# colour thresholds run the other way.
if [ -n "$cache_pct" ]; then
  cache_int=$(printf '%.0f' "$cache_pct")
  if [ "$cache_int" -ge 80 ]; then cache_color="$GREEN"
  elif [ "$cache_int" -ge 50 ]; then cache_color="$ACCENT"
  else cache_color="$RED"; fi
  cache_eta_str=""
  [ -n "$cache_eta" ] && cache_eta_str="$(printf "${SUBTLE}[%s]${RESET}" "$cache_eta")"
  l1_left+=("$(printf "${cache_color}cache${RESET}%s ${cache_color}%d%%${RESET}" \
    "$cache_eta_str" "$cache_int")")
fi

if [ -n "$five_pct" ]; then
  l1_left+=("$(rate_segment 5h 18000 "$(printf '%.0f' "$five_pct")" "$five_reset")")
fi

if [ -n "$week_pct" ]; then
  l1_left+=("$(rate_segment 7d 604800 "$(printf '%.0f' "$week_pct")" "$week_reset")")
fi

# --- Line 1 right: model (color = effort state) ---
model_label="$model"
[ "$thinking" = "true" ] && model_label="${model_label}*"
case "$effort" in
  max)        model_color="$RED" ;;
  high|xhigh) model_color="$ACCENT" ;;
  *)          model_color="$MUTED" ;;
esac
l1_right="$(printf "${model_color}%s${RESET}" "$model_label")"

# --- Line 2: repo branch diff ---
l2=()

if [ -n "$branch" ]; then
  l2+=("$(printf "${ACCENT}%s${RESET} ${SUBTLE}%s${RESET}" "$dir" "$branch")")
else
  l2+=("$(printf "${ACCENT}%s${RESET}" "$dir")")
fi

if [ "$diff_added" -gt 0 ] || [ "$diff_removed" -gt 0 ]; then
  l2+=("$(printf "${GREEN}+%d${RESET} ${RED}-%d${RESET}" "$diff_added" "$diff_removed")")
fi

# --- Output ---
# The model is not one of the meters, so it gets a plain gap instead of a dot.
line1="$(join_parts "${l1_left[@]}")"
[ -n "$line1" ] && line1="${l1_right}  ${line1}" || line1="$l1_right"
line2="${l2[*]}"

printf '%b\n' "$line1"
[ -n "$line2" ] && printf '%b\n' "$line2"
