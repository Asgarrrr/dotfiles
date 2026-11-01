set shell := ["bash", "-cu"]

dotfiles_dir := justfile_directory()

default:
  @just --list

install:
  bash "{{dotfiles_dir}}/install.sh"

relink:
  ln -sf "{{dotfiles_dir}}/.zshrc" "$HOME/.zshrc"
  ln -sf "{{dotfiles_dir}}/.gitconfig" "$HOME/.gitconfig"
  ln -sf "{{dotfiles_dir}}/.gitignore_global" "$HOME/.gitignore_global"
  ln -sf "{{dotfiles_dir}}/.hushlogin" "$HOME/.hushlogin"
  mkdir -p "$HOME/.config/zed" "$HOME/.config/ghostty" "$HOME/.config/fastfetch"
  ln -sf "{{dotfiles_dir}}/.config/zed/settings.json" "$HOME/.config/zed/settings.json"
  if [[ -f "{{dotfiles_dir}}/.config/zed/keymap.json" ]]; then ln -sf "{{dotfiles_dir}}/.config/zed/keymap.json" "$HOME/.config/zed/keymap.json"; fi
  ln -sf "{{dotfiles_dir}}/.config/ghostty/config.ghostty" "$HOME/.config/ghostty/config.ghostty"
  ln -sf "{{dotfiles_dir}}/.config/starship.toml" "$HOME/.config/starship.toml"
  ln -sf "{{dotfiles_dir}}/.config/fastfetch/config.jsonc" "$HOME/.config/fastfetch/config.jsonc"
  just ai-link

ai-link:
  #!/usr/bin/env bash
  set -euo pipefail
  dotfiles_dir="{{dotfiles_dir}}"

  mkdir -p "$HOME/.agents" "$HOME/.claude" "$HOME/.codex"
  ln -sf "$dotfiles_dir/.agents/README.md" "$HOME/.agents/README.md"
  ln -sf "$dotfiles_dir/.agents/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  ln -sf "$dotfiles_dir/.agents/claude/RTK.md" "$HOME/.claude/RTK.md"
  ln -sf "$dotfiles_dir/.agents/claude/settings.json" "$HOME/.claude/settings.json"
  ln -sf "$dotfiles_dir/.agents/claude/statusline-command.sh" "$HOME/.claude/statusline-command.sh"
  ln -sfn "$dotfiles_dir/.agents/claude/hooks" "$HOME/.claude/hooks"
  ln -sfn "$dotfiles_dir/.agents/claude/rules" "$HOME/.claude/rules"
  ln -sf "$dotfiles_dir/.agents/codex/config.toml" "$HOME/.codex/config.toml"

  # Both skill dirs point at the repo as a whole: one copy, and anything a tool
  # writes there shows up in git status. Which skills load is set by
  # skillOverrides in settings.json, not by which links exist.
  for dir in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    if [[ -e "$dir" && ! -L "$dir" ]]; then
      echo "real directory in the way, move it aside first: $dir" >&2
      exit 1
    fi
    ln -sfn "$dotfiles_dir/.agents/skills" "$dir"
  done

brew:
  brew bundle --file "{{dotfiles_dir}}/Brewfile"

update:
  brew update
  brew upgrade
  brew bundle --file "{{dotfiles_dir}}/Brewfile"
  if command -v fnm >/dev/null 2>&1; then fnm install --lts; fi
  if [[ -f "{{dotfiles_dir}}/node-globals.txt" ]] && command -v bun >/dev/null 2>&1; then xargs bun install -g < "{{dotfiles_dir}}/node-globals.txt"; fi

doctor:
  #!/usr/bin/env bash
  set -u
  ok=0; fail=0
  check_cmd() { if command -v "$1" >/dev/null 2>&1; then echo "  ok   $1"; ok=$((ok+1)); else echo "  MISS $1"; fail=$((fail+1)); fi; }
  check_link() { if [[ -L "$1" ]]; then echo "  ok   $1"; ok=$((ok+1)); else echo "  MISS $1"; fail=$((fail+1)); fi; }
  echo "commands:"
  for c in brew zsh fnm zoxide fzf starship just; do check_cmd "$c"; done
  echo "symlinks:"
  for l in "$HOME/.zshrc" "$HOME/.gitconfig" "$HOME/.gitignore_global" "$HOME/.hushlogin"; do check_link "$l"; done
  echo "—"
  echo "passed: $ok  failed: $fail"
  [[ $fail -eq 0 ]]

ai-doctor:
  #!/usr/bin/env bash
  set -u
  ok=0; fail=0
  check_cmd() { if command -v "$1" >/dev/null 2>&1; then echo "  ok   $1"; ok=$((ok+1)); else echo "  MISS $1"; fail=$((fail+1)); fi; }
  check_link() { if [[ -L "$1" ]]; then echo "  ok   $1"; ok=$((ok+1)); else echo "  MISS $1"; fail=$((fail+1)); fi; }
  echo "commands:"
  for c in bun codex claude jq; do check_cmd "$c"; done
  echo "global config:"
  for l in "$HOME/.agents/README.md" "$HOME/.claude/CLAUDE.md" "$HOME/.claude/RTK.md" "$HOME/.claude/settings.json" "$HOME/.claude/hooks" "$HOME/.claude/rules"; do check_link "$l"; done
  if [[ -f "$HOME/.codex/config.toml" ]]; then echo "  ok   $HOME/.codex/config.toml"; ok=$((ok+1)); else echo "  MISS $HOME/.codex/config.toml"; fail=$((fail+1)); fi
  echo "skills:"
  pool="{{dotfiles_dir}}/.agents/skills"
  for dir in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    if [[ "$(readlink "$dir")" == "$pool" ]]; then echo "  ok   $dir"; ok=$((ok+1)); else echo "  MISS $dir -> $pool"; fail=$((fail+1)); fi
  done
  if names="$(jq -r '.skillOverrides // {} | keys[]' "{{dotfiles_dir}}/.agents/claude/settings.json")"; then
    for name in $names; do
      [[ -d "$pool/$name" ]] || { echo "  MISS skillOverrides names a skill not in the pool: $name"; fail=$((fail+1)); }
    done
  else
    echo "  MISS cannot read skillOverrides from settings.json"; fail=$((fail+1))
  fi
  echo "—"
  echo "passed: $ok  failed: $fail"
  [[ $fail -eq 0 ]]

macos:
  bash "{{dotfiles_dir}}/macos.sh"
