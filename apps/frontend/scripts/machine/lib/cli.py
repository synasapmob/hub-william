"""`./install.sh` — argv in, exit code out. The work lives in actions.py."""

import os
import sys

from . import actions, banner, catalog, lock, mcpauth, paths
from . import profile as profile_mod, sync, tui, ui
from .actions import HelpRequest, UsageError, parse_flags


def _name(value):
    """A name you typed wrong is a usage error, not a broken catalog."""
    try:
        return catalog.check_name(value)
    except catalog.CatalogError as exc:
        raise UsageError(str(exc))


USAGE = """\
usage: ./install.sh <command>

  init                      browse the catalog and pick, then apply it
                            ↑↓ move · ←→ level · space toggle · enter sync
  sync                      re-apply the catalog: adds install, drops uninstall
  update                    git pull this checkout, then sync
  status                    catalog, CLIs, profile, and anything pending

  skill add    <name> [--agent claude|codex|grok|all]
  skill remove <name> [--agent ...] [--delete-catalog]

  mcp add    <name> <command...>          stdio server, e.g. npx @playwright/mcp
  mcp add    <name> --url <url>           streamable HTTP server
  mcp remove <name> [--agent ...] [--keep-catalog]
  mcp auth   [<name>] [--agent ...]       log in to the OAuth servers

options
  --contributor <name>  select a contributor's optional harness and Codex roles;
                        saved in this machine's profile (default: default)
  --agent <list>   comma-separated, no spaces. Naming agents is explicit: an
                   add lifts a previous deny for exactly those agents and a
                   remove writes one. Omitting --agent means every agent on
                   PATH, and never lifts a deny.
  --dry-run        print the plan, change nothing
  --force-mcp      overwrite an MCP block this installer does not own
  --no-plugins     skip the vendor `plugin install` steps
  --no-shared      leave shared shell configuration untouched
  --adopt          (sync) allow every catalog item nobody has decided on
  --yes            skip the questions: `init` takes the prefilled answers and
                   neither command asks before applying

Flags come before the spawn command; use `--` when the command could be
mistaken for one:

  ./install.sh mcp add playwright npx @playwright/mcp@latest
  ./install.sh mcp add playwright --agent claude -- npx -y @playwright/mcp
  ./install.sh mcp add linear --url https://mcp.linear.app/mcp
"""


def cmd_help(_tokens):
    banner.show("setup")
    sys.stdout.write(USAGE)
    return 0


def cmd_init(tokens):
    args = parse_flags(tokens)
    if args.rest:
        raise UsageError("init takes no positional arguments")
    return tui.run_init(args)


def cmd_sync(tokens):
    args = parse_flags(tokens)
    if args.rest:
        raise UsageError("sync takes no positional arguments")
    return actions.run_sync(args)


def cmd_update(tokens):
    args = parse_flags(tokens)
    if args.rest:
        raise UsageError("update takes no positional arguments")
    return actions.update(args)


def cmd_status(tokens):
    args = parse_flags(tokens)
    if args.rest:
        raise UsageError("status takes no positional arguments")
    return actions.status(args)


def cmd_skill(tokens):
    if not tokens:
        raise UsageError("skill needs `add` or `remove`")
    verb, rest = tokens[0], tokens[1:]
    if verb not in ("add", "remove"):
        raise UsageError("skill takes `add` or `remove`, not %r" % verb)
    args = parse_flags(rest)
    if len(args.rest) != 1:
        raise UsageError("skill %s needs exactly one name" % verb)
    name = _name(args.rest[0])

    profile = profile_mod.Profile.load()
    extra = []

    if verb == "add":
        if not catalog.find_skill(name):
            raise UsageError(
                "no skill %r in the catalog. Author it first:\n  %s/%s/SKILL.md"
                % (name, paths.tilde(paths.skills_catalog()), name)
            )
        actions.touch_profile(profile, "skills", name, args, want=True)
    else:
        actions.touch_profile(profile, "skills", name, args, want=False)
        if args.delete_catalog:
            if args.agent is not None:
                raise UsageError("--delete-catalog is a global move; drop --agent")
            skill = catalog.find_skill(name)
            if skill:
                if not args.dry_run:
                    catalog.delete_skill(name)
                extra.append(sync.Change(
                    "remove", "catalog", name, None, detail=paths.tilde(skill.path)
                ))

    if not args.dry_run:
        profile.save()
    return actions.run_sync(args, subtitle=verb, profile=profile, extra=extra)


def cmd_mcp(tokens):
    if not tokens:
        raise UsageError("mcp needs `add`, `remove` or `auth`")
    verb, rest = tokens[0], tokens[1:]
    if verb == "auth":
        return cmd_mcp_auth(rest)
    if verb not in ("add", "remove"):
        raise UsageError("mcp takes `add`, `remove` or `auth`, not %r" % verb)
    if not rest:
        raise UsageError("mcp %s needs a name" % verb)

    name = _name(rest[0])
    args = parse_flags(rest[1:], stop_at_positional=(verb == "add"))
    if args.rest:
        raise UsageError("unexpected argument %r" % args.rest[0])

    profile = profile_mod.Profile.load()
    extra = []

    if verb == "add":
        extra.extend(_mcp_add_catalog(name, args))
        actions.touch_profile(profile, "mcp", name, args, want=True)
    else:
        actions.touch_profile(profile, "mcp", name, args, want=False)
        # A global `mcp remove` also drops the catalog entry: `mcp add` wrote
        # that file, so `mcp remove` takes it back. Skills are hand-authored
        # and stay unless you ask for --delete-catalog.
        if args.agent is None and not args.keep_catalog:
            path = catalog.mcp_path(name)
            if os.path.isfile(path):
                if not args.dry_run:
                    catalog.delete_mcp(name)
                extra.append(sync.Change(
                    "remove", "catalog", name, None, detail=paths.tilde(path)
                ))

    if not args.dry_run:
        profile.save()
    return actions.run_sync(args, subtitle=verb, profile=profile, extra=extra)


def _mcp_add_catalog(name, args):
    if args.url and args.command:
        raise UsageError("give either --url or a command, not both")
    spec = None
    if args.url:
        spec = {"url": args.url}
    elif args.command:
        spec = {"command": args.command[0], "args": list(args.command[1:])}
    if args.env:
        if spec is None:
            raise UsageError("--env needs a command or --url too")
        spec["env"] = dict(args.env)

    if spec is None:
        # `mcp add <name> --agent codex` with no spec is the deny-lifting form.
        if not catalog.find_mcp(name):
            raise UsageError("no MCP %r in the catalog; give a command or --url" % name)
        return []

    path = catalog.mcp_path(name)
    verb = "update" if os.path.exists(path) else "add"
    if not args.dry_run:
        catalog.write_mcp(name, spec, args.description)
    return [sync.Change(
        verb, "catalog", name, None, detail=paths.tilde(path),
        reason=("not written in a dry run, so no agent changes below"
                if args.dry_run else ""),
    )]


def cmd_mcp_auth(tokens):
    args = parse_flags(tokens)
    if len(args.rest) > 1:
        raise UsageError("mcp auth takes at most one name")
    return mcpauth.run(args.rest[0] if args.rest else None, args)


COMMANDS = {
    "init": cmd_init,
    "sync": cmd_sync,
    "update": cmd_update,
    "status": cmd_status,
    "skill": cmd_skill,
    "skills": cmd_skill,
    "mcp": cmd_mcp,
    "help": cmd_help,
}

_MUTATING = ("init", "sync", "update", "skill", "skills", "mcp")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help", "help"):
        return cmd_help(argv[1:] if argv else [])

    name = argv[0]
    handler = COMMANDS.get(name)
    if handler is None:
        ui.error("unknown command %r" % name)
        sys.stdout.write(USAGE)
        return 2

    # `mcp auth` opens browsers but writes nothing, so it does not take the lock.
    mutating = name in _MUTATING and "--dry-run" not in argv
    if name == "mcp" and len(argv) > 1 and argv[1] == "auth":
        mutating = False

    try:
        if mutating:
            with lock.Lock():
                return handler(argv[1:])
        return handler(argv[1:])
    except HelpRequest:
        sys.stdout.write(USAGE)
        return 0
    except UsageError as exc:
        if str(exc):
            ui.error(str(exc))
        sys.stdout.write(USAGE)
        return 2
    except (sync.ScopeError, catalog.CatalogError, lock.LockBusy, ValueError) as exc:
        ui.error(str(exc))
        return 1
    except KeyboardInterrupt:
        ui.say("")
        ui.error("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
