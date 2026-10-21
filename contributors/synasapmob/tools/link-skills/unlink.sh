#!/usr/bin/env bash
# unlink-skills: remove the Hub William skills that link.sh installed
#
# Removes the agent links that point at the installed skills, then moves the
# installed skills to ~/.agents/.backups so nothing is lost. Your own skills and
# ~/.agents/AGENTS.md are left alone.
#
# Run it from the site, or from your own copy with `bash unlink.sh`:
#   curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/link-skills/unlink.sh | bash
#
# AGENTS_HOME overrides the folder that link.sh installed into.

set -euo pipefail

AGENTS_HOME="${AGENTS_HOME:-$HOME/.agents}"
skills_home="$AGENTS_HOME/skills"
manifest="$AGENTS_HOME/.hub-william-skills"
rules="$AGENTS_HOME/AGENTS.md"

if [ ! -f "$manifest" ]; then
  echo "unlink-skills: nothing to remove ($manifest not found)"
  exit 0
fi

# Moving skills out of a symlinked folder would take them out of its target.
if [ -L "$skills_home" ]; then
  echo "unlink-skills: $skills_home is a symlink to $(readlink "$skills_home"); not touching it" >&2
  exit 1
fi

remove_link() {
  local path="$1" target="$2"

  if [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ]; then
    rm "$path"
  fi
}

stamp="$(date +%Y%m%d-%H%M%S)"
while IFS= read -r name; do
  [ -n "$name" ] || continue

  remove_link "$HOME/.claude/skills/$name" "$skills_home/$name"
  remove_link "$HOME/.codex/skills/$name" "$skills_home/$name"

  if [ -d "$skills_home/$name" ] && [ ! -L "$skills_home/$name" ]; then
    mkdir -p "$AGENTS_HOME/.backups/$stamp"
    mv "$skills_home/$name" "$AGENTS_HOME/.backups/$stamp/$name"
    echo "unlink-skills: moved $name to $AGENTS_HOME/.backups/$stamp/$name"
  fi
done <"$manifest"

remove_link "$HOME/.claude/CLAUDE.md" "$rules"
remove_link "$HOME/.codex/AGENTS.md" "$rules"
remove_link "$HOME/.dsh/AGENTS.md" "$rules"

rm "$manifest"
echo "unlink-skills: done; $rules was left in place"
