# The `dopa-tps` command — dopamint-arena's local TPS stack.
#
# The work is in dopa-tps.bash next to this file, and it stays bash: it leans
# on word splitting, arrays and `compgen`, none of which mean the same thing
# in zsh. Those differences do not raise errors, they just quietly do
# something else — in a script whose job is killing processes and wiping
# docker volumes. So it is executed, not sourced.
#
# This file is a symlink into the checkout, so it finds its script by
# resolving itself rather than guessing a path.
#
# It is deliberately not pinned to one directory. `dopa-tps` acts on the
# worktree you are standing in — each dopamint-arena worktree runs its own
# stack — and refuses, with its own message, anywhere else.

_dopa_tps_script="${${(%):-%x}:A:h}/dopa-tps.bash"

dopa-tps() {
  if [[ ! -r "$_dopa_tps_script" ]]; then
    echo "dopa-tps: missing $_dopa_tps_script" >&2
    return 1
  fi
  bash "$_dopa_tps_script" "$@"
}
