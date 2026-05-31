# dotfiles

Minimal macOS dev environment.

## Install

```bash
git clone git@github.com:Asgarrrr/dotfiles.git ~/dotfiles
cd ~/dotfiles && ./install.sh
```

Installs Homebrew + the `Brewfile`, the latest LTS Node via `fnm`, Claude Code,
then symlinks every config into `$HOME`.

## Stack

- **shell** — `zsh`, `starship`, `fzf`, `zoxide`, autosuggestions, syntax highlighting
- **apps** — `Ghostty`, `Zed`, `Raycast`
- **runtimes** — `fnm` (Node), `bun`, `uv`
- **AI hub** — shared `Claude Code` + `Codex` config under `.agents/`

## Tasks

```bash
just          # list everything
just relink   # refresh symlinks
just update   # update brew + runtimes
just doctor   # check the setup
just macos    # apply optional macOS defaults
```

## Layout

| Path | What |
|------|------|
| `.zshrc`, `.zsh/` | shell entrypoint, aliases, helpers |
| `.config/` | `starship`, `ghostty`, `zed`, `fastfetch` |
| `.agents/` | global Claude/Codex config + shared skills |
| `Brewfile` | packages and casks |
| `install.sh` | bootstrap a new machine |
| `justfile` | task runner |

Reload shell changes with `exec zsh`.
