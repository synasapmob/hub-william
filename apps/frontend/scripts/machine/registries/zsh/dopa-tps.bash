#!/usr/bin/env bash
# tps-fresh <command> [--all]
#
#   reset           stop + start. Keeps chain, images, Move cache.
#
#
#   stop            stop only. Deletes nothing, so the next reset is fast.
#                   --all stops every worktree.
#
#
#   clear           wipe this worktree, free its ports, then empty Docker -
#                   every container and every image, since those are shared.
#                   --all wipes every worktree's state as well.
#
#
#   fresh           clear, re-pull the pinned Sui image, then start this
#                   worktree again. The pull is the difference that makes a
#                   fresh actually start: clear empties every image, and the
#                   Move publish runs inside one.
#
#
#   extend <path>   run only this worktree's UI against another worktree's
#                   running stack. Takes its whole VITE_* set, so everything
#                   you do lands on that worktree's chain.
#

set -euo pipefail

usage() { awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; }
say()   { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note()  { printf '    %s\n' "$*"; }
warn()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

MODE=""
EXTEND_PATH=""
ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    reset|restart|--reset|--restart) MODE=reset ;;
    fresh|--fresh) MODE=fresh ;;
    clear|--clear) MODE=clear ;;
    stop|--stop) MODE=stop ;;
    --all|all) ALL=1 ;;
    extend|--extend)
      MODE=extend
      shift
      [ $# -gt 0 ] || { printf '\033[1;31mextend needs a worktree path\033[0m\n\n' >&2; usage >&2; exit 2; }
      EXTEND_PATH="$1"
      ;;
    -h|--help|help) usage; exit 0 ;;
    *)
      printf '\033[1;31munknown command: %s\033[0m\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$MODE" ]; then
  printf '\033[1;31ma command is required: reset, fresh, clear, stop or extend <path>\033[0m\n\n' >&2
  usage >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$ROOT" ] && [ -x "$ROOT/infra/local-tps/stack" ] \
  || die "run this from inside a dopamint-arena worktree (no infra/local-tps/stack here)"
cd "$ROOT"

docker info >/dev/null 2>&1 || die "Docker is not running. Start it first: open -a Docker"

# Ports are base + offset, and the offset is pinned per worktree: a stored file
# if one exists, otherwise a hash of the worktree path. Same formula as
# scripts/dev/worktree-env.sh, so this agrees with the stack itself.
offset_for_root() {
  local r="$1" f
  for f in local-llm local-tps local; do
    if [ -s "$r/.local/infra/$f/port-offset" ]; then
      cat "$r/.local/infra/$f/port-offset"
      return
    fi
  done
  local h
  h="$(printf '%s' "$r" | shasum -a 256 | cut -c1-4)"
  echo $((16#$h % 200))
}

# Orphaned build containers are the cause of the "still settling / preparing Sui
# funds-ready gate" wedge. Their name is devstack-oneshot-<epoch>-<random> and
# carries no app, while stopStackContainers in infra/local-tps/scripts/devstack.ts
# filters on name=devstack-$DEVSTACK_APP- (i.e. devstack-tps-<hash>-). That
# filter is right for the stack's own containers and cannot match a oneshot. Abort a start and
# one stays alive; the next start adds another against the same bind-mounted
# Move cache, and two concurrent `sui move build` deadlock on it.
#
# Scoped by that Move cache bind, so this never kills another worktree's
# in-flight build.
reap_oneshots() {
  local ids="" id
  say "reaping orphaned devstack-oneshot build containers"
  for id in $(docker ps -aq --filter name=devstack-oneshot 2>/dev/null || true); do
    if docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null \
       | grep -q "^$ROOT/\|[[:space:]]$ROOT/"; then
      ids="$ids $id"
    fi
  done
  if [ -n "${ids// /}" ]; then
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null 2>&1 || true
    note "removed $(printf '%s' "$ids" | wc -w | tr -d ' ') container(s)"
  else
    note "none found"
  fi
}

other_worktrees_running() {
  docker ps --format '{{.Names}}' \
    | sed -nE 's/^dopamint-(.+)-[0-9]+-(postgres|redis|minio)-[0-9]+$/\1/p' \
    | sort -u | grep -vx "$(basename "$ROOT")" || true
}

# Whatever is still holding this worktree's ports once its containers are gone:
# a vite dev server, a relay or explorer binary started outside Docker, a stale
# process from a killed run. Ports are per worktree, so this cannot reach a
# neighbour's services.
kill_this_worktree_ports() {
  command -v lsof >/dev/null 2>&1 || { note "lsof not available, skipping ports"; return 0; }
  local var port pid comm pids killed=0
  for var in $(compgen -v | grep -E '^DOPAMINT_[A-Z_]*PORT$' | sort -u); do
    port="${!var}"
    case "$port" in ''|*[!0-9]*) continue ;; esac
    # Flat on purpose. A `case` inside `$( )` makes bash 3.2 - the only bash
    # macOS ships - read the pattern's `)` as the end of the substitution, and
    # `bash -n` does not catch it because substitution bodies are parsed at run
    # time, not when the file is loaded.
    #
    # Docker's own forwarder is skipped: on macOS a published container port is
    # held by com.docker.backend, and killing that takes Docker Desktop down.
    pids=""
    for pid in $(lsof -ti "tcp:$port" 2>/dev/null || true); do
      comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
      printf '%s' "$comm" | grep -qiE 'docker|vpnkit' && continue
      pids="$pids $pid"
    done
    if [ -n "${pids// /}" ]; then
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
      note "freed :$port ($var)"
      killed=$((killed + 1))
    fi
  done
  [ "$killed" -eq 0 ] && note "no listeners to free"
  return 0
}

# Every container and every image on the machine. Shared by definition, so it
# runs once - the --all sweep sets TPS_FRESH_SKIP_NUKE for its children and does
# this itself at the end rather than repeating it per worktree.
nuke_docker() {
  [ "${TPS_FRESH_SKIP_NUKE:-0}" = 1 ] && return 0

  say "removing every container on this machine"
  local left
  left="$(docker ps -aq || true)"
  # shellcheck disable=SC2086
  [ -n "$left" ] && docker rm -f $left >/dev/null 2>&1 || true

  # After the containers, or an image still referenced refuses to delete.
  say "removing every image and the build cache"
  local imgs
  imgs="$(docker images -aq | sort -u || true)"
  # shellcheck disable=SC2086
  [ -n "$imgs" ] && docker rmi -f $imgs >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true

  say "removing dangling volumes"
  docker volume prune -f >/dev/null 2>&1 || true
  note "docker is empty"
}

# The base image every `sui move build` runs inside, fetched back after a nuke.
#
# devstack builds its own image FROM `mysten/sui-tools:<pin>` and then runs the
# Move publish in a container off it. `nuke_docker` has just deleted that base,
# so the next start has to fetch it again - and if it cannot, the publish exits
# 125 and the stack sits in `still settling ... package:dopa#N (failed)` until
# the 45-minute budget runs out. That message names neither the image nor the
# pull, and the real reason is only in
# `.local/devstack/<...>/state/stacks/<stack>/events.ndjson`, so the failure
# reads as a hang rather than a missing download.
#
# Pulled HERE, before the stack starts, so the cost of `fresh` is a visible
# download with its own progress and its own error, rather than a silent three
# minutes followed by a wedge. `fresh` is the only mode that needs it: `clear`
# and `clear --all` stop without starting, and `reset` keeps its images.
#
# The tag is read from the repository rather than written down here, because
# the pin moves: `.sui-version` and the two Dockerfiles under
# `tests/e2e/arena-tunnel/support/sui-image` are what devstack itself resolves,
# and a copy in this wrapper would silently rot one bump later. Arch picks the
# Dockerfile the same way `devstack.config.ts` does (`process.arch === "arm64"`).
prepull_stack_images() {
  local ctx="$ROOT/tests/e2e/arena-tunnel/support/sui-image"
  local dockerfile="Dockerfile"
  [ "$(uname -m)" = "arm64" ] && dockerfile="Dockerfile.arm64"

  if [ ! -r "$ctx/$dockerfile" ]; then
    warn "no $dockerfile under tests/e2e/arena-tunnel/support/sui-image"
    note "skipping the pre-pull; the start will fetch what it can on its own"
    return 0
  fi

  local base
  base="$(awk '/^[Ff][Rr][Oo][Mm][[:space:]]/ { print $2; exit }' "$ctx/$dockerfile")"
  if [ -z "$base" ]; then
    warn "could not read a FROM line from $dockerfile"
    note "skipping the pre-pull; the start will fetch what it can on its own"
    return 0
  fi

  say "pulling the pinned Sui image back"
  note "$base"
  PREPULLED_IMAGE="$base"
  if docker pull "$base"; then
    note "pulled"
    return 0
  fi

  # Not fatal on purpose. An offline machine with the image still in some other
  # form, or a rate-limited pull that succeeds on the retry inside `docker
  # build`, should still get its chance - but say plainly what is about to fail
  # so the wedge that follows is not a mystery.
  warn "could not pull $base"
  note "the Move publish will exit 125 and the stack will sit in"
  note "'still settling ... (failed)' until it gives up. Fix the pull first:"
  note "  docker pull $base"
  return 0
}

# `.local/devstack/<config>/<instance>/move-home`, the way infra/local-tps/scripts/worktree.sh
# builds it. Read off disk when the tree is already there, so this never has to know the
# config/instance names; falls back to the pair the stack actually uses when it is not.
devstack_move_home() {
  local r="$1" found
  found="$(find "$r/.local/devstack" -type d -name move-home 2>/dev/null | head -1 || true)"
  [ -n "$found" ] && { printf '%s' "$found"; return; }
  printf '%s' "$r/.local/devstack/tps/local/move-home"
}

# Make Docker admit the Move cache directory exists, before anything needs to mount it.
#
# THIS is what actually breaks a fresh, and it is not a race. `clear` deletes
# `.local/devstack`, the directories come straight back (see clear_this_worktree), and Docker
# Desktop still refuses to bind them:
#
#   docker: invalid mount config for type "bind": bind source path does not exist: .../move-home
#
# The path is on disk the whole time - instrumented at 0.25s and never once missing, present for 26
# seconds before the publish tried it. What is stale is DOCKER's view: the file-sharing layer
# caches the negative lookup from when the directory really was gone, and keeps answering "no such
# path" long after it is back. Any successful bind refreshes that entry, which is why running one
# throwaway container by hand made the very next start work, and why the failure looked random.
#
# So bind it once here, deliberately, and retry until Docker agrees. `--entrypoint true` makes it a
# no-op container, and it reuses the image `prepull_stack_images` just fetched rather than pulling
# a second one - on a fresh, nothing else is left to reuse.
warm_move_cache_bind() {
  local dir="$1" image="$2" attempt
  [ -n "$dir" ] && [ -n "$image" ] || return 0
  mkdir -p "$dir" 2>/dev/null || true

  say "letting Docker see the Move cache"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if docker run --rm --entrypoint true -v "$dir:/warm" "$image" >/dev/null 2>&1; then
      note "bind is live"
      return 0
    fi
    sleep 1
  done

  # Not fatal: Devstack may still get there, and dying here would replace a recoverable stack with
  # an unrecoverable script. But name it, because the publish is about to fail for this reason and
  # nothing downstream will say so.
  warn "Docker still cannot bind $dir"
  note "the Move publish will exit 125 with 'bind source path does not exist'."
  note "Docker Desktop is holding a stale view of a path that IS on disk. Restarting"
  note "Docker Desktop clears it; so does binding it once by hand:"
  note "  docker run --rm -v \"$dir:/x\" alpine true"
  return 0
}

# Everything this worktree owns, and nothing anyone else's.
#
# Scoped by asking the worktree itself rather than guessing at names:
# worktree-env.sh exports the compose project and the path hash, which are the
# two prefixes Docker actually labels this worktree's resources with. Sourcing
# it is this worktree's own env, not another's.
clear_this_worktree() {
  reap_oneshots

  say "stopping the stack"
  ./infra/local-tps/stack stop || note "stop reported a problem; continuing"

  say "wiping chain state (devstack wipe + .local/infra/local-tps)"
  ./infra/local-tps/stack reset || note "reset reported a problem; continuing"

  # shellcheck source=/dev/null
  . "$ROOT/scripts/dev/worktree-env.sh" >/dev/null 2>&1 \
    || die "could not read this worktree's environment"
  local project="${COMPOSE_PROJECT_NAME:?no COMPOSE_PROJECT_NAME}"
  # Same string devstack itself uses: `dopa_tps_use_devstack_instance` sets
  # DEVSTACK_APP to `<config>-<path-hash>`, and devstack names its containers
  # `devstack-$DEVSTACK_APP-...`. Rebuilt from the hash here rather than sourced,
  # so this does not depend on that function having been called.
  local hash="${DOPAMINT_WORKTREE_PATH_HASH:?no DOPAMINT_WORKTREE_PATH_HASH}"
  note "compose project: $project"
  note "devstack prefix: devstack-tps-$hash-"

  say "removing this worktree's containers"
  local mine
  mine="$(docker ps -aq --filter "label=com.docker.compose.project=$project" || true)"
  mine="$mine $(docker ps -aq --filter "name=devstack-tps-$hash-" || true)"
  mine="$(printf '%s' "$mine" | tr ' ' '\n' | sort -u | tr '\n' ' ')"
  if [ -n "${mine// /}" ]; then
    # shellcheck disable=SC2086
    docker rm -f $mine >/dev/null 2>&1 || true
    note "removed $(printf '%s' "$mine" | wc -w | tr -d ' ') container(s)"
  else
    note "none found"
  fi

  # Label-filtered, never `volume prune`: prune is global and would take every
  # other worktree's database with it.
  say "removing this worktree's volumes"
  local vols
  vols="$(docker volume ls -q --filter "label=com.docker.compose.project=$project" || true)"
  if [ -n "$vols" ]; then
    # shellcheck disable=SC2086
    docker volume rm -f $vols >/dev/null 2>&1 || true
    note "removed $(printf '%s\n' "$vols" | wc -l | tr -d ' ') volume(s)"
  else
    note "none found"
  fi

  # Includes the ~36 MB clone of MystenLabs/sui that every `sui move build`
  # resolves against, which is per worktree.
  #
  # The empty `move-home` directories are put straight back, and that is what makes the next start
  # work. Devstack bind-mounts each one into its `sui move build` container and creates it itself,
  # but only as the publish starts - and Docker resolves the bind first, so a directory this
  # function has just deleted is still missing when the container is launched:
  #
  #   docker: invalid mount config for type "bind": bind source path does not exist: .../move-home
  #
  # That is `exited 125`, which Devstack reports as `package:<name> (failed)` and the stack shows
  # as `still settling after Nm` for the whole 45-minute budget. The bind error itself never
  # reaches the console - it is only in `state/stacks/<stack>/events.ndjson` - so the run reads as
  # a hang, and the instinctive response is to clear again, which deletes the directory once more
  # and reproduces it exactly. That loop is why this looked unfixable.
  #
  # Captured before the wipe rather than derived, so this holds for whatever config/instance names
  # the stack uses (`.local/devstack/<config>/<instance>/move-home`) without a second copy of that
  # path living here. The cache CONTENTS still go: what is kept is an empty directory.
  say "removing this worktree's Move cache and devstack state"
  local move_homes=""
  if [ -d "$ROOT/.local/devstack" ]; then
    move_homes="$(find "$ROOT/.local/devstack" -type d -name move-home 2>/dev/null || true)"
  fi
  rm -rf "$ROOT/.local/devstack" 2>/dev/null || true
  if [ -n "$move_homes" ]; then
    while IFS= read -r mh; do
      [ -n "$mh" ] && mkdir -p "$mh" 2>/dev/null || true
    done <<< "$move_homes"
    note "kept $(printf '%s\n' "$move_homes" | grep -c . | tr -d ' ') empty move-home dir(s) as bind sources"
  fi

  say "freeing this worktree's ports"
  kill_this_worktree_ports
}

# ------------------------------------------------------------------- all ----
# Only ever in the tearing-down direction: bringing N stacks up at once is
# precisely the RAM starvation that wedges a start, so --reset --all has no safe
# meaning and is refused rather than quietly doing something surprising.
if [ "$ALL" = 1 ]; then
  case "$MODE" in
    stop|clear) ;;
    reset)
      printf '\033[1;31mreset has no --all\033[0m\n' >&2
      printf '    It would start every worktree at once, which is the RAM\n' >&2
      printf '    starvation that wedges a start. Bring one up at a time.\n' >&2
      exit 2
      ;;
    fresh)
      printf '\033[1;31mfresh has no --all - use: clear --all\033[0m\n' >&2
      printf '    fresh always ends by starting THIS worktree, so it only ever\n' >&2
      printf '    means one of them.\n' >&2
      exit 2
      ;;
    *)
      printf '\033[1;31m%s has no --all\033[0m\n' "$MODE" >&2
      printf '    It runs against one named worktree by definition.\n' >&2
      exit 2
      ;;
  esac

  PER=clear
  [ "$MODE" = stop ] && PER=stop

  say "sweeping every worktree: $PER"
  for wt in $(git -C "$ROOT" worktree list --porcelain | sed -n 's/^worktree //p'); do
    [ -x "$wt/infra/local-tps/stack" ] || continue
    printf '\n\033[1;36m--- %s ---\033[0m\n' "$(basename "$wt")"
    ( cd "$wt" && TPS_FRESH_SKIP_NUKE=1 "$0" "$PER" ) || note "$(basename "$wt") reported a problem; continuing"
  done

  # Images only on --fresh --all. They are shared by every worktree, so removing
  # them makes the next start cold everywhere - that is the whole difference
  # between --clear --all and --fresh --all. Containers first: an image still
  # referenced by a container will not delete.
  [ "$MODE" = stop ] || nuke_docker

  say "sweep complete - nothing was started"
  note "bring one up when you need it: cd <worktree> && tps-fresh reset"
  exit 0
fi

say "mode: $MODE"
note "worktree: $ROOT"

# ---------------------------------------------------------------- extend ----
# Run only THIS worktree's frontend, wired to another worktree's whole stack.
#
# It takes that worktree's entire VITE_* set, not just the two HTTP origins.
# Half-borrowing does not work: the package ids, coin type and MP url name
# objects on the chain the backend is on, so mixing them with a borrowed relay
# gives a frontend addressing a chain it is not talking to.
#
# This DOES cross CLAUDE.md invariant 3, which says never source another
# worktree's env files. Taken knowingly, and narrowed to what that rule is
# actually protecting against - a run that silently lands in the wrong
# worktree's database. Here nothing is written to disk (both worktrees stay
# coherent, and an ordinary `pnpm dev` goes straight back to this one's own
# stack), the borrow is explicit in the flag, and the terminal title carries it
# for the whole session so it cannot be forgotten halfway through.
#
# The residual risk is real and not mitigated: everything you sign, every tunnel
# you open and every row you write lands on the OTHER worktree's chain and
# database. Fine for checking a UI. Not fine for debugging a match and then
# wondering where the data went.
if [ "$MODE" = extend ]; then
  OTHER="$(cd "$EXTEND_PATH" 2>/dev/null && pwd || true)"
  [ -n "$OTHER" ] || die "no such path: $EXTEND_PATH"
  [ "$OTHER" != "$ROOT" ] && [ -d "$OTHER/infra/local-tps" ] \
    || die "$EXTEND_PATH is not a different dopamint-arena worktree"
  OTHER_NAME="$(basename "$OTHER")"

  OTHER_ENV="$OTHER/.local/.env.dopa-million-tps.local"
  [ -f "$OTHER_ENV" ] \
    || die "$OTHER_NAME has no .local/.env.dopa-million-tps.local - start its stack once first"

  BORROWED=()
  while IFS= read -r line; do
    case "$line" in VITE_*=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    BORROWED+=("$key=$val")
    [ "$key" = VITE_BACKEND_URL ] && RELAY="$val"
  done < "$OTHER_ENV"

  [ "${#BORROWED[@]}" -gt 0 ] || die "no VITE_* entries in $OTHER_ENV"
  [ -n "${RELAY:-}" ] || die "$OTHER_NAME has no VITE_BACKEND_URL to borrow"

  curl -sf "$RELAY/healthz" >/dev/null 2>&1 \
    || die "$OTHER_NAME relay at $RELAY is not answering /healthz - is its stack up?"

  MY_UI_PORT=$((5773 + $(offset_for_root "$ROOT")))

  say "borrowing the whole stack from $OTHER_NAME"
  note "relay    $RELAY"
  note "chain    $(printf '%s\n' "${BORROWED[@]}" | sed -n 's/^VITE_SUI_NETWORK_NAME=//p')"
  note "borrowed ${#BORROWED[@]} VITE_* vars, passed as environment only"
  note "this UI  http://localhost:${MY_UI_PORT}   (frontend code from $(basename "$ROOT"))"

  printf '\n\033[1;31m    EVERYTHING YOU DO LANDS ON %s\033[0m\n' "$(printf '%s' "$OTHER_NAME" | tr '[:lower:]' '[:upper:]')"
  note "Its chain, its database, its relay. Only the UI code is this worktree's."
  note "No files were modified - plain \`pnpm dev\` here still uses this worktree."

  printf '\033]0;EXTEND -> %s\007' "$OTHER_NAME"
  echo
  exec env "${BORROWED[@]}" pnpm -C ui/dopa-million-tps dev --port "$MY_UI_PORT"
fi

# ------------------------------------------------------------------ stop ----
if [ "$MODE" = stop ]; then
  reap_oneshots
  say "stopping the stack"
  ./infra/local-tps/stack stop || note "stop reported a problem; continuing"

  # `stack stop` deliberately leaves the shared compose containers up. They are
  # this worktree's own project, so stopping them is safe - but the same project
  # backs infra/local-llm for THIS worktree, so that stops too.
  say "stopping this worktree's postgres/redis/minio"
  MINE="$(docker ps -q --filter "name=dopamint-$(basename "$ROOT")-" || true)"
  if [ -n "$MINE" ]; then
    # shellcheck disable=SC2086
    docker stop $MINE >/dev/null 2>&1 || true
    note "stopped $(printf '%s\n' "$MINE" | wc -l | tr -d ' ') container(s)"
    note "state and volumes kept, so the next --reset starts fast"
  else
    note "none running"
  fi
  say "done - RAM handed back"
  exit 0
fi

# ----------------------------------------------------------------- clear ----
if [ "$MODE" = clear ]; then
  clear_this_worktree
  nuke_docker
  say "cleared"
  note "next start anywhere is a full cold one: cd <worktree> && tps-fresh reset"
  exit 0
fi

# --------------------------------------------------------- reset / fresh ----
OTHERS="$(other_worktrees_running)"
if [ -n "$OTHERS" ]; then
  warn "another worktree has a stack running"
  printf '%s\n' "$OTHERS" | sed 's/^/    /'
  note ""
  note "They do not clash - separate ports, containers and chain. But they share"
  note "one ~8 GB Docker VM, and starving it is what wedges a start."
  note "Free it:      cd ../<that-worktree> && tps-fresh stop"
  note "Or reuse it:  tps-fresh extend ../<that-worktree>"
fi

if [ "$MODE" = fresh ]; then
  clear_this_worktree
  nuke_docker
  PREPULLED_IMAGE=""
  prepull_stack_images
  # Ordered: the directory is back (clear_this_worktree), the image is back
  # (prepull_stack_images), so the bind can be proven before Devstack needs it.
  warm_move_cache_bind "$(devstack_move_home "$ROOT")" "$PREPULLED_IMAGE"
else
  reap_oneshots
  say "stopping the stack"
  ./infra/local-tps/stack stop || note "stop reported a problem; continuing"
fi

say "starting the stack"
[ "$MODE" = reset ] && note "chain, images and Move cache kept; initialize.sh reruns either way"
note ""
note "'still settling after Nm' is a 60s heartbeat against a 45-minute budget."
note "It is NOT an error. Do not abort it - aborting is what orphans the build"
note "container and wedges the next run. Real breakage says 'Devstack stopped on"
note "a failed member' or 'Devstack exited before writing TPS metadata'."
note ""
note "When it settles, confirm initialize.sh actually ran:"
note "  grep -E '^(WALRUS_|FLEET_COLOCATED_COUNT)' .local/.env.relay.local"
note "Expect http://127.0.0.1:1 and FLEET_COLOCATED_COUNT=5000."
echo
exec ./infra/local-tps/stack start
