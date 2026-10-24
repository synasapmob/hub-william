#!/usr/bin/env bash
# link-skills: install the Hub William skills into ~/.agents
#
# Copies every skill into ~/.agents/skills, saves the shared rules as
# ~/.agents/AGENTS.md, then links the agents that do not read ~/.agents themselves
# (see the table below) to those copies. It never deletes your work: a skill that
# already exists is moved to ~/.agents/.backups first, and so is a rules file that
# is still an unedited copy of an earlier install, before the new one replaces it.
# A rules file you edited is left alone, with the new rules saved beside it.
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

# A single shared file is more likely to be yours than a skill, so it is replaced
# only while it is still an unedited copy of what this script installed. That is
# known from the hash of the last copy installed, kept in rules_record, or from
# LEGACY_RULES_SHA256, the one copy that shipped before the record existed. A file
# you edited, or a symlink, is kept.
LEGACY_RULES_SHA256="6b3e7fe58f2cddee9e3eb7d2776d695e2e42974f2a99243a27ba1b3041e1a661"
rules="$AGENTS_HOME/AGENTS.md"
rules_record="$AGENTS_HOME/.hub-william-rules"
rules_beside="$AGENTS_HOME/AGENTS.hub-william.md"
shipped_rules="$source_dir/rules/AGENTS.md"

# The hash of a file, or nothing when this machine has no sha256 tool.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

unedited_rules() {
  local current known
  current="$(sha256_of "$1")"
  [ -n "$current" ] || return 1
  known="$(cat "$rules_record" 2>/dev/null || true)"
  [ "$current" = "$LEGACY_RULES_SHA256" ] || [ "$current" = "$known" ]
}

if [ -f "$shipped_rules" ]; then
  if [ ! -e "$rules" ] && [ ! -L "$rules" ]; then
    cp "$shipped_rules" "$rules"
    sha256_of "$rules" >"$rules_record"
    note "saved the shared rules as $rules"
  elif cmp -s "$shipped_rules" "$rules"; then
    [ -L "$rules" ] || sha256_of "$rules" >"$rules_record"
  elif [ ! -L "$rules" ] && unedited_rules "$rules"; then
    mkdir -p "$AGENTS_HOME/.backups/$stamp"
    mv "$rules" "$AGENTS_HOME/.backups/$stamp/AGENTS.md"
    cp "$shipped_rules" "$rules"
    sha256_of "$rules" >"$rules_record"
    note "updated $rules; the previous copy is in $AGENTS_HOME/.backups/$stamp/AGENTS.md"
  else
    cp "$shipped_rules" "$rules_beside"
    note "kept your $rules; the Hub William rules are in $rules_beside"
  fi

  # The copy saved beside your file is redundant once AGENTS.md holds the same rules.
  if [ -f "$rules_beside" ] && cmp -s "$shipped_rules" "$rules" && cmp -s "$shipped_rules" "$rules_beside"; then
    rm -f -- "$rules_beside"
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
