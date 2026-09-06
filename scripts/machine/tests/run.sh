#!/usr/bin/env bash
# Run the suite under every python3 on this machine, oldest first.
#
# The system python on macOS is 3.9 and has no tomllib, which is why lib/ has
# its own TOML layer. If a change only passes on 3.13, it is broken here.

set -uo pipefail

TESTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACHINE_DIR="$(dirname "$TESTS_DIR")"

pythons=()
for candidate in /usr/bin/python3 python3.9 python3.10 python3.11 python3.12 python3.13 python3.14 python3; do
  resolved="$(command -v "$candidate" 2>/dev/null)" || continue
  resolved="$(cd -P "$(dirname "$resolved")" && pwd)/$(basename "$resolved")"
  version="$("$resolved" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || continue
  case " ${pythons[*]:-} " in *" $version "*) continue ;; esac
  pythons+=("$version" "$resolved")
done

if [ ${#pythons[@]} -eq 0 ]; then
  echo "no python3 found" >&2
  exit 1
fi

status=0
index=0
while [ $index -lt ${#pythons[@]} ]; do
  version="${pythons[$index]}"
  binary="${pythons[$((index + 1))]}"
  index=$((index + 2))
  echo "=== python $version ($binary) ==="
  if ! (cd "$MACHINE_DIR" && "$binary" -m unittest discover -s tests -p 'test_*.py' -v "$@"); then
    status=1
  fi
done

exit $status
