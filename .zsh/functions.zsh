take() {
  [[ -n "$1" ]] || return 1
  mkdir -p "$1" && cd "$1"
}

ff() {
  local file

  command -v fd >/dev/null 2>&1 || return 1
  command -v fzf >/dev/null 2>&1 || return 1
  file="$(fd --type f --hidden --follow --exclude .git | fzf)" || return
  [[ -n "$file" ]] && print -r -- "$file"
}

fe() {
  local file

  command -v fd >/dev/null 2>&1 || return 1
  command -v fzf >/dev/null 2>&1 || return 1
  file="$(fd --type f --hidden --follow --exclude .git | fzf)" || return
  [[ -n "$file" ]] || return

  if command -v zed >/dev/null 2>&1; then
    zed "$file"
  else
    print -r -- "$file"
  fi
}

fcd() {
  local dir

  command -v fd >/dev/null 2>&1 || return 1
  command -v fzf >/dev/null 2>&1 || return 1
  dir="$(fd --type d --hidden --follow --exclude .git | fzf)" || return
  [[ -n "$dir" ]] && cd "$dir"
}
