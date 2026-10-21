#!/usr/bin/env bash
# link-skills: install the Hub William skills into ~/.agents
#
# Copies every skill into ~/.agents/skills, saves the shared rules as
# ~/.agents/AGENTS.md, then links the agents found on this machine to those
# copies. It only adds: a skill that already exists is moved to
# ~/.agents/.backups first, and a rules file you already have is left alone.
#
# Run it from the site:
#   curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/scripts/link-skills/link.sh | bash
# Or point it at a skills folder you unpacked yourself:
#   bash link.sh --from contributors/synasapmob/skills
#
# Undo it with unlink.sh, next to this file.
# HUB_WILLIAM_ORIGIN and AGENTS_HOME override the site and the target folder.

set -euo pipefail

ORIGIN="${HUB_WILLIAM_ORIGIN:-https://hub-william.site}"
AGENTS_HOME="${AGENTS_HOME:-$HOME/.agents}"
BUNDLE="catalog/collections/synasapmob/skills.zip"
BUNDLE_ROOT="contributors/synasapmob/skills"

die() {
  echo "link-skills: $*" >&2
  exit 1
}

note() {
  echo "link-skills: $*"
}

source_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from)
      [ $# -ge 2 ] || die "--from needs a folder"
      source_dir="$2"
      shift 2
      ;;
    --from=*)
      source_dir="${1#--from=}"
      shift
      ;;
    *)
      die "unknown option: $1 (use --from FOLDER, or no option to download)"
      ;;
  esac
done

if [ -z "$source_dir" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v unzip >/dev/null 2>&1 || die "unzip is required"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  curl -fsSL "$ORIGIN/$BUNDLE" -o "$work/skills.zip" || die "could not download $ORIGIN/$BUNDLE"
  unzip -q "$work/skills.zip" -d "$work/unpacked" || die "could not unpack the skills bundle"
  source_dir="$work/unpacked/$BUNDLE_ROOT"
fi
[ -d "$source_dir" ] || die "not a folder: $source_dir"

# Copying through a symlink would write into whatever it points at.
skills_home="$AGENTS_HOME/skills"
if [ -L "$skills_home" ]; then
  die "$skills_home is a symlink to $(readlink "$skills_home"); remove the link, or set AGENTS_HOME to another folder"
fi
mkdir -p "$skills_home"

stamp="$(date +%Y%m%d-%H%M%S)"
installed=""
for skill in "$source_dir"/*/; do
  [ -f "${skill}SKILL.md" ] || continue

  name="$(basename "$skill")"
  target="$skills_home/$name"

  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ ! -L "$target" ] && diff -r "$skill" "$target" >/dev/null 2>&1; then
      installed="$installed$name"$'\n'
      continue
    fi

    # Outside skills/, or an agent would load the backup as a second copy.
    mkdir -p "$AGENTS_HOME/.backups/$stamp"
    mv "$target" "$AGENTS_HOME/.backups/$stamp/$name"
    note "moved your existing $name to $AGENTS_HOME/.backups/$stamp/$name"
  fi

  cp -R "${skill%/}" "$target"
  installed="$installed$name"$'\n'
done
[ -n "$installed" ] || die "no skills found in $source_dir"

# unlink.sh reads this list to remove only what was installed here.
manifest="$AGENTS_HOME/.hub-william-skills"
{
  [ -f "$manifest" ] && cat "$manifest"
  printf '%s' "$installed"
} | sort -u >"$manifest.tmp"
mv "$manifest.tmp" "$manifest"

# A single shared file is more likely to be yours than a skill, so keep it.
rules="$AGENTS_HOME/AGENTS.md"
if [ -f "$source_dir/rules/AGENTS.md" ]; then
  if [ ! -e "$rules" ] && [ ! -L "$rules" ]; then
    cp "$source_dir/rules/AGENTS.md" "$rules"
    note "saved the shared rules as $rules"
  elif ! cmp -s "$source_dir/rules/AGENTS.md" "$rules"; then
    cp "$source_dir/rules/AGENTS.md" "$AGENTS_HOME/AGENTS.hub-william.md"
    note "kept your $rules; the Hub William rules are in $AGENTS_HOME/AGENTS.hub-william.md"
  fi
fi

# Create a link only where nothing exists yet, or where it already points here.
link_to() {
  local path="$1" target="$2"

  if [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ]; then
    return 0
  fi

  if [ -e "$path" ] || [ -L "$path" ]; then
    note "left $path as it is"
    return 0
  fi

  mkdir -p "$(dirname "$path")"
  ln -s "$target" "$path"
}

for agent in "$HOME/.claude" "$HOME/.codex"; do
  [ -d "$agent" ] || continue

  printf '%s' "$installed" | while IFS= read -r name; do
    link_to "$agent/skills/$name" "$skills_home/$name"
  done
done

if [ -f "$rules" ]; then
  for file in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md" "$HOME/.dsh/AGENTS.md"; do
    [ -d "$(dirname "$file")" ] || continue
    link_to "$file" "$rules"
  done

  claude_rules="$HOME/.claude/CLAUDE.md"
  if [ -f "$claude_rules" ] && [ "$(readlink "$claude_rules" 2>/dev/null || true)" != "$rules" ]; then
    note "to load the shared rules in Claude Code, add this line to $claude_rules:  @$rules"
  fi
fi

count="$(printf '%s' "$installed" | wc -l | tr -d ' ')"
note "installed $count skills into $skills_home"
