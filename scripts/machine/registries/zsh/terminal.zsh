# Global history
HISTFILE="$HOME/.zsh_history"
HISTSIZE=10000
SAVEHIST=10000

setopt APPEND_HISTORY
setopt INC_APPEND_HISTORY
setopt SHARE_HISTORY

# Autosuggestions. Guarded, so a machine without brew or without the formula
# still gets a working shell instead of an error on every login.
ZSH_AUTOSUGGEST_STRATEGY=(history completion)
_hw_autosuggest="$(brew --prefix 2>/dev/null)/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
[ -r "$_hw_autosuggest" ] && source "$_hw_autosuggest"
unset _hw_autosuggest
