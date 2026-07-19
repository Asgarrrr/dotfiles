#!/usr/bin/env bash
set -euo pipefail
# So, you got a new machine, nice, i'm proud of you —


DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"


if ! command -v brew &>/dev/null; then
    echo "01. Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [[ $(uname -m) == "arm64" ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
fi

if [ -f "$DOTFILES_DIR/Brewfile" ]; then
    echo "02. Installing packages from Brewfile..."
    brew bundle --file="$DOTFILES_DIR/Brewfile"
fi

if [ ! -d "$HOME/.oh-my-zsh" ]; then
    echo "02b. Installing oh-my-zsh..."
    RUNZSH=no KEEP_ZSHRC=yes CHSH=no \
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
fi

if command -v fnm &>/dev/null; then
  fnm install --lts
fi

if [ -f "$DOTFILES_DIR/node-globals.txt" ] && command -v bun &>/dev/null; then
  xargs bun install -g < "$DOTFILES_DIR/node-globals.txt"
fi

if ! command -v claude &>/dev/null; then
    echo "03. Installing Claude Code..."
    curl -fsSL https://claude.ai/install.sh | bash
else
    echo "03. Claude Code already installed."
fi


echo "04. Linking config files..."
( cd "$DOTFILES_DIR" && just relink )

if command -v zsh &>/dev/null && [[ "$SHELL" != *zsh ]]; then
    echo "05. Setting zsh as the default shell..."
    zsh_path="$(command -v zsh)"
    grep -qxF "$zsh_path" /etc/shells || echo "$zsh_path" | sudo tee -a /etc/shells >/dev/null
    chsh -s "$zsh_path" || echo "    Could not change shell automatically — run: chsh -s $zsh_path"
fi

echo "06. Checking AI tooling..."
( cd "$DOTFILES_DIR" && just ai-doctor )
