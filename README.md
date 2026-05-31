# dotfiles

> Minimal macOS dev environment — `zsh` + `starship`, fuzzy everything, and a shared AI hub.

```bash
git clone git@github.com:Asgarrrr/dotfiles.git ~/dotfiles
cd ~/dotfiles && ./install.sh
```

Installs Homebrew + the `Brewfile`, the latest LTS Node via `fnm`, Claude Code,
then symlinks every config into `$HOME`.

---

## Stack

|              |                                                                              |
| ------------ | ---------------------------------------------------------------------------- |
| **Shell**    | `zsh` · `starship` · `fzf` · `zoxide` · autosuggestions · syntax-highlighting |
| **Apps**     | `Ghostty` · `Zed` · `Raycast`                                                 |
| **Runtimes** | `fnm` (Node) · `bun` · `uv`                                                   |
| **AI hub**   | `Claude Code` + `Codex` — shared config & skills under `.agents/`             |

## Daily use

**Helpers**

| Command      | Does                              |
| ------------ | --------------------------------- |
| `ff`         | fuzzy-find a file → print path    |
| `fe`         | fuzzy-find a file → open in Zed   |
| `fcd`        | fuzzy-find a directory → `cd`     |
| `take <dir>` | create a directory and enter it   |

**Keys** — <kbd>⌃T</kbd> find files · <kbd>⌃R</kbd> search history · <kbd>⌥C</kbd> jump to a directory

**Aliases** — `gs` status · `glog` graph log · `gdc` diff cached · `cc` claude · `cx` codex

## Tasks

```bash
just          # list everything
just update   # update brew + runtimes
just doctor   # check the setup
just relink   # refresh symlinks
just macos    # optional macOS defaults
```

## Layout

| Path                  | What                                       |
| --------------------- | ------------------------------------------ |
| `.zshrc` · `.zsh/`    | shell entrypoint, aliases, helpers         |
| `.config/`            | `starship` · `ghostty` · `zed` · `fastfetch` |
| `.agents/`            | global Claude/Codex config + shared skills |
| `Brewfile`            | packages & casks                           |
| `install.sh` · `justfile` | bootstrap + task runner                |

<sub>Reload shell changes with `exec zsh`.</sub>
