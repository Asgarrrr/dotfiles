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
  stamp="$(date +%Y%m%d%H%M%S)"

  mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.codex"
  ln -sf "$dotfiles_dir/.agents/README.md" "$HOME/.agents/README.md"
  ln -sf "$dotfiles_dir/.agents/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  ln -sf "$dotfiles_dir/.agents/claude/RTK.md" "$HOME/.claude/RTK.md"
  ln -sf "$dotfiles_dir/.agents/claude/settings.json" "$HOME/.claude/settings.json"
  ln -sf "$dotfiles_dir/.agents/claude/statusline-command.sh" "$HOME/.claude/statusline-command.sh"
  ln -sfn "$dotfiles_dir/.agents/claude/hooks" "$HOME/.claude/hooks"
  ln -sfn "$dotfiles_dir/.agents/claude/rules" "$HOME/.claude/rules"
  ln -sf "$dotfiles_dir/.agents/codex/config.toml" "$HOME/.codex/config.toml"

  # ~/.agents/skills is the catalog; only the skills named in skills.txt load
  # globally, the rest are switched on per project with `just skill-on`.
  shopt -s nullglob
  for skill in "$dotfiles_dir"/.agents/skills/*; do
    [[ -d "$skill" ]] || continue
    name="$(basename "$skill")"
    home_skill="$HOME/.agents/skills/$name"

    if [[ -e "$home_skill" && ! -L "$home_skill" ]]; then
      mv "$home_skill" "$HOME/.agents/skills/${name}.pre-dotfiles-$stamp"
    fi

    ln -sfn "$skill" "$home_skill"
  done

  for link in "$HOME"/.claude/skills/*; do
    [[ -L "$link" ]] || continue
    grep -qxF "$(basename "$link")" "$dotfiles_dir/.agents/claude/skills.txt" || rm "$link"
  done
  while read -r name; do
    [[ -n "$name" ]] || continue
    if [[ -e "$HOME/.agents/skills/$name" ]]; then
      ln -sfn "../../.agents/skills/$name" "$HOME/.claude/skills/$name"
    else
      echo "  not in catalog: $name" >&2
    fi
  done < "$dotfiles_dir/.agents/claude/skills.txt"

# List the skill catalog: g = loaded globally, p = loaded in the current directory's project.
skills:
  #!/usr/bin/env bash
  set -euo pipefail
  shopt -s nullglob
  cd "{{invocation_directory()}}"
  for skill in "$HOME"/.agents/skills/*; do
    name="$(basename "$skill")"
    [[ "$name" == *.pre-dotfiles-* ]] && continue
    g=" "; p=" "
    [[ -e "$HOME/.claude/skills/$name" ]] && g="g"
    [[ -e ".claude/skills/$name" && "$PWD" != "$HOME" ]] && p="p"
    echo "  $g$p $name"
  done

# Load a catalog skill globally, or in the current directory's project.
skill-on name scope="global":
  #!/usr/bin/env bash
  set -euo pipefail
  name="{{name}}"; list="{{dotfiles_dir}}/.agents/claude/skills.txt"
  [[ -e "$HOME/.agents/skills/$name" ]] || { echo "not in catalog: $name (see just skills)" >&2; exit 1; }
  case "{{scope}}" in
    global)
      grep -qxF "$name" "$list" || { echo "$name" >> "$list"; sort -o "$list" "$list"; }
      ln -sfn "../../.agents/skills/$name" "$HOME/.claude/skills/$name" ;;
    project)
      cd "{{invocation_directory()}}"
      mkdir -p .claude/skills
      ln -sfn "$HOME/.agents/skills/$name" ".claude/skills/$name" ;;
    *) echo "scope must be global or project" >&2; exit 1 ;;
  esac
  echo "on ({{scope}}): $name"

# Unload a skill; it stays in the catalog.
skill-off name scope="global":
  #!/usr/bin/env bash
  set -euo pipefail
  name="{{name}}"; list="{{dotfiles_dir}}/.agents/claude/skills.txt"
  case "{{scope}}" in
    global)
      grep -vxF "$name" "$list" > "$list.tmp" || true; mv "$list.tmp" "$list"
      target="$HOME/.claude/skills/$name" ;;
    project) target="{{invocation_directory()}}/.claude/skills/$name" ;;
    *) echo "scope must be global or project" >&2; exit 1 ;;
  esac
  if [[ -L "$target" ]]; then rm "$target"; elif [[ -e "$target" ]]; then echo "not a link, left alone: $target" >&2; exit 1; fi
  echo "off ({{scope}}): $name"

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
  for c in bun codex claude; do check_cmd "$c"; done
  echo "global config:"
  for l in "$HOME/.agents/README.md" "$HOME/.claude/CLAUDE.md" "$HOME/.claude/RTK.md" "$HOME/.claude/settings.json" "$HOME/.claude/hooks" "$HOME/.claude/rules"; do check_link "$l"; done
  if [[ -f "$HOME/.codex/config.toml" ]]; then echo "  ok   $HOME/.codex/config.toml"; ok=$((ok+1)); else echo "  MISS $HOME/.codex/config.toml"; fail=$((fail+1)); fi
  echo "skills:"
  shopt -s nullglob
  for skill in "{{dotfiles_dir}}"/.agents/skills/*; do
    [[ -d "$skill" ]] || continue
    name="$(basename "$skill")"
    check_link "$HOME/.agents/skills/$name"
  done
  echo "global skills:"
  while read -r name; do
    [[ -n "$name" ]] && check_link "$HOME/.claude/skills/$name"
  done < "{{dotfiles_dir}}/.agents/claude/skills.txt"
  echo "—"
  echo "passed: $ok  failed: $fail"
  [[ $fail -eq 0 ]]

macos:
  bash "{{dotfiles_dir}}/macos.sh"
