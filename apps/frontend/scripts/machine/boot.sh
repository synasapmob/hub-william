#!/bin/sh
# Put the machine harness in ~/.hub-william and run it.
#
#   gh api -H "Accept: application/vnd.github.raw" \
#     repos/Southern-Discoveries/hub-william/contents/apps/frontend/scripts/machine/boot.sh | sh
#
# The repo is private, so `gh` is what authenticates — both to fetch this file
# and to clone. No token has to be in the environment, and nothing is written
# outside ~/.hub-william until the installer asks you.
#
# Run it again any time. It clones when there is nothing there and pulls when
# there is, so this one line is both "install" and "update" and you never have
# to know which. Add a command to run something other than `init`:
#
#   ... | sh -s -- sync
#   ... | sh -s -- status
#
# Once it is installed, `hub-william <command>` is the same thing without gh.
set -eu

REPO="${HUB_WILLIAM_REPO:-Southern-Discoveries/hub-william}"
HOME_DIR="${HUB_WILLIAM_HOME:-$HOME/.hub-william}"
# A branch to install from, for trying one before it is merged. Empty means
# the default branch, which is what you want every other time.
REF="${HUB_WILLIAM_REF:-}"

[ "$#" -gt 0 ] || set -- init

say() { printf 'hub-william: %s\n' "$1"; }
die() { printf 'hub-william: %s\n' "$1" >&2; exit 1; }

# The installer and the documents it installs are separate trees, so the
# checkout has to name both or an install arrives with no catalogue.
sparse() {
  git -C "$HOME_DIR" sparse-checkout set --no-cone \
    '/apps/frontend/scripts/' '/contributors/'
}

command -v git >/dev/null 2>&1 || die "git is not on PATH"
command -v gh  >/dev/null 2>&1 || die "gh is not on PATH — brew install gh"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"

if [ -e "$HOME_DIR/.git" ]; then
  say "already at $HOME_DIR — pulling"
  git -C "$HOME_DIR" pull --ff-only
  # Tighten an older checkout, but never narrow one that was never sparse:
  # HUB_WILLIAM_HOME could be pointed at a full clone someone works in.
  if [ "$(git -C "$HOME_DIR" config --get core.sparseCheckout 2>/dev/null || echo false)" = "true" ]; then
    sparse
  fi
else
  [ -e "$HOME_DIR" ] && die "$HOME_DIR exists and is not a git checkout"
  say "cloning $REPO${REF:+ ($REF)} into $HOME_DIR"
  # Partial and sparse: no blobs until something needs them, and only
  # machine/ in the working tree.
  if [ -n "$REF" ]; then
    gh repo clone "$REPO" "$HOME_DIR" -- --filter=blob:none --sparse --branch "$REF"
  else
    gh repo clone "$REPO" "$HOME_DIR" -- --filter=blob:none --sparse
  fi
  sparse
fi

[ -d "$HOME_DIR/apps/frontend/scripts/machine" ] || die "no apps/frontend/scripts/machine in $HOME_DIR — wrong branch?"

INSTALL="$HOME_DIR/apps/frontend/scripts/machine/install.sh"
[ -x "$INSTALL" ] || die "no installer at $INSTALL"

# stdin is this script coming down the pipe, so the installer would see no
# terminal and stop asking questions. Hand it the real one — but only when
# there is a person there: stdout redirected means this is a script, and a
# script does not want a full-screen picker.
if [ -r /dev/tty ] && [ -t 1 ]; then
  exec "$INSTALL" "$@" < /dev/tty
fi

say "installed at $HOME_DIR"
say "next: $INSTALL $*"
