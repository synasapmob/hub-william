#!/usr/bin/env bash
# link-skills: install the Hub William skills into ~/.agents
#
# Copies every skill into ~/.agents/skills, saves the shared rules as
# ~/.agents/AGENTS.md, then links the agents that do not read ~/.agents themselves
# (see the table below) to those copies. It only adds: a skill that already exists
# is moved to ~/.agents/.backups first, and a rules file you already have is left
# alone.
#
# Two ways to run it. Without --path it fetches the skills from Hub William, so
# use that only if you trust it:
#   curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/link-skills/link.sh | bash
# With --path it reads your own copy and fetches nothing. PATH is the Skills zip
# you downloaded, or the folder you unzipped it into:
#   curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/link-skills/link.sh | bash -s -- --path=~/Downloads/skills.zip
# Or run a downloaded copy of this file: bash link.sh --path=~/Downloads/skills.zip
#
# Undo it with unlink.sh, next to this file.
# HUB_WILLIAM_ORIGIN and AGENTS_HOME override the site and the target folder.

set -euo pipefail

ORIGIN="${HUB_WILLIAM_ORIGIN:-https://hub-william.site}"
AGENTS_HOME="${AGENTS_HOME:-$HOME/.agents}"
BUNDLE="catalog/collections/synasapmob/tools/skills.zip"
BUNDLE_ROOT="contributors/synasapmob/tools/skills"

die() {
  echo "link-skills: $*" >&2
  exit 1
}

note() {
  echo "link-skills: $*"
}

path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --path)
      [ $# -ge 2 ] || die "--path needs a zip file or a folder"
      path="$2"
      shift 2
      ;;
    --path=*)
      path="${1#--path=}"
      shift
      ;;
    *)
      die "unknown option: $1 (use --path=ZIP_OR_FOLDER, or no option to fetch from Hub William)"
      ;;
  esac
done

# --path=~/x reaches us with the tilde unexpanded.
case "$path" in
  "~") path="$HOME" ;;
  "~/"*) path="$HOME/${path#\~/}" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

unpack() {
  command -v unzip >/dev/null 2>&1 || die "unzip is required"
  unzip -q "$1" -d "$work/unpacked" || die "could not unpack $1"
}

if [ -z "$path" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  curl -fsSL "$ORIGIN/$BUNDLE" -o "$work/skills.zip" || die "could not download $ORIGIN/$BUNDLE"
  unpack "$work/skills.zip"
  source_dir="$work/unpacked"
elif [ -f "$path" ]; then
  case "$path" in
    *.zip) unpack "$path" ;;
    *) die "not a zip file or a folder: $path" ;;
  esac
  source_dir="$work/unpacked"
elif [ -d "$path" ]; then
  source_dir="$path"
else
  die "not found: $path"
fi

# The zip unpacks to contributors/.../skills; a folder you copied may be that
# skills folder itself.
if [ -d "$source_dir/$BUNDLE_ROOT" ]; then
  source_dir="$source_dir/$BUNDLE_ROOT"
fi

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

# Which agents use their own config and which use the shared ~/.agents:
#
#   own config   Claude Code and agy; they never read ~/.agents, so they are linked
#   ~/.agents    DSH, and OpenCode for skills (its rules were not checked)
#   mixed        Codex: skills from ~/.agents, rules from ~/.codex/AGENTS.md
#
# Each agent was run against a home where only ~/.agents held the skills and the
# rules (October 2026; check again when an agent updates):
#
#   agent        skills from ~/.agents/skills   rules from ~/.agents/AGENTS.md
#   Claude Code  no                             no
#   Codex        yes                            no
#   DSH          yes                            yes
#   OpenCode     yes                            not checked
#   agy          no                             no
#
# So a link is made only where an agent does not read ~/.agents itself:
#   Claude Code  skills  ~/.claude/skills/<name>          rules  ~/.claude/CLAUDE.md
#   Codex        none                                     rules  ~/.codex/AGENTS.md
#   agy          skills  ~/.gemini/config/skills/<name>   rules  ~/.gemini/AGENTS.md
#
# agy keeps its global skills and rules under ~/.gemini; its only .agents/skills is
# the one inside a project, so ~/.agents/skills is invisible to it. Without these
# links it lists only its built-in skills and has no rules.

# Skills: "<agent folder>:<its skills folder>".
for entry in ".claude:skills" ".gemini:config/skills"; do
  agent="$HOME/${entry%%:*}"
  [ -d "$agent" ] || continue

  printf '%s' "$installed" | while IFS= read -r name; do
    link_to "$agent/${entry#*:}/$name" "$skills_home/$name"
  done
done

if [ -f "$rules" ]; then
  for file in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md" "$HOME/.gemini/AGENTS.md"; do
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
