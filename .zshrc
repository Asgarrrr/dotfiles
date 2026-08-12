export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
DOTFILES_DIR="$HOME/dotfiles"
export STARSHIP_CONFIG="$DOTFILES_DIR/.config/starship.toml"

export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME=""
plugins=(git)

source "$ZSH/oh-my-zsh.sh"

if [[ -d /opt/homebrew ]]; then
  export HOMEBREW_PREFIX="/opt/homebrew"
elif [[ -d /usr/local ]]; then
  export HOMEBREW_PREFIX="/usr/local"
fi

zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'

command -v fnm >/dev/null 2>&1 && eval "$(fnm env --use-on-cd --shell zsh)"
if command -v fd >/dev/null 2>&1; then
  export FZF_DEFAULT_COMMAND='fd --type f --strip-cwd-prefix --hidden --follow --exclude .git'
  export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
  export FZF_ALT_C_COMMAND='fd --type d --strip-cwd-prefix --hidden --follow --exclude .git'
fi
command -v zoxide >/dev/null 2>&1 && eval "$(zoxide init zsh)"
[[ -f "$DOTFILES_DIR/.zsh/aliases.zsh" ]] && source "$DOTFILES_DIR/.zsh/aliases.zsh"
[[ -f "$DOTFILES_DIR/.zsh/functions.zsh" ]] && source "$DOTFILES_DIR/.zsh/functions.zsh"

if [[ -t 0 && -t 1 ]]; then
  command -v fzf >/dev/null 2>&1 && source <(fzf --zsh)
  [[ -n "${HOMEBREW_PREFIX:-}" && -f "$HOMEBREW_PREFIX/opt/fzf-tab/share/fzf-tab/fzf-tab.zsh" ]] && source "$HOMEBREW_PREFIX/opt/fzf-tab/share/fzf-tab/fzf-tab.zsh"

  ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=8'
  [[ -n "${HOMEBREW_PREFIX:-}" && -f "$HOMEBREW_PREFIX/opt/zsh-autosuggestions/share/zsh-autosuggestions/zsh-autosuggestions.zsh" ]] && source "$HOMEBREW_PREFIX/opt/zsh-autosuggestions/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
  command -v starship >/dev/null 2>&1 && eval "$(starship init zsh)"
  [[ -n "${HOMEBREW_PREFIX:-}" && -f "$HOMEBREW_PREFIX/opt/zsh-syntax-highlighting/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" ]] && source "$HOMEBREW_PREFIX/opt/zsh-syntax-highlighting/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
fi

# bun completions
[ -s "/Users/asgarrrr/.bun/_bun" ] && source "/Users/asgarrrr/.bun/_bun"
