#!/usr/bin/env bash
# Hub William machine harness.
#
# Thin wrapper: find a usable python3, then hand the argv to lib/cli.py.
# Everything else lives in lib/. Keep this file boring.

set -euo pipefail

# Resolve this script's real directory, following symlinks.
src="${BASH_SOURCE[0]}"
while [ -L "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  case "$src" in
    /*) ;;
    *) src="$dir/$src" ;;
  esac
done
MACHINE_DIR="$(cd -P "$(dirname "$src")" && pwd)"

find_python() {
  local candidate resolved
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3.9 python3 python; do
    resolved="$(command -v "$candidate" 2>/dev/null)" || continue
    if "$resolved" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  return 1
}

PY="${HUB_WILLIAM_PYTHON:-}"
if [ -z "$PY" ]; then
  if ! PY="$(find_python)"; then
    echo "machine: needs python3 >= 3.8 on PATH (macOS ships one at /usr/bin/python3)" >&2
    exit 1
  fi
fi

# Keep __pycache__ out of the repo; the CLI is short-lived anyway.
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$MACHINE_DIR${PYTHONPATH:+:$PYTHONPATH}"
export HUB_WILLIAM_MACHINE_DIR="$MACHINE_DIR"

exec "$PY" -m lib.cli "$@"
