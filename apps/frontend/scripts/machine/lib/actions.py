"""The verbs behind the CLI, shared with the init TUI.

Argument parsing is hand-rolled rather than argparse, because
`mcp add <name> <argv...>` has to take the rest of the line verbatim,
including words that look like flags.
"""

import os
import subprocess

from . import banner, catalog, paths, probe, profile as profile_mod
from . import state as state_mod, sync, ui
from .agents import AGENT_NAMES


class UsageError(Exception):
    pass


class HelpRequest(UsageError):
    """`-h` anywhere. Same output as a usage error, but you asked for it."""


class Args(object):
    """Parsed flags plus whatever positional words are left."""

    def __init__(self):
        self.agent = None
        self.contributor = None
        self.dry_run = False
        self.force_mcp = False
        self.plugins = True
        self.shared = True
        self.adopt = False
        self.delete_catalog = False
        self.keep_catalog = False
        self.force = False
        self.yes = False
        self.url = None
        self.description = ""
        self.env = {}
        self.rest = []
        self.command = []


_FLAGS_WITH_VALUE = ("--agent", "--contributor", "--url", "--description", "--env")
_BOOL_FLAGS = {
    "--dry-run": "dry_run",
    "--force-mcp": "force_mcp",
    "--adopt": "adopt",
    "--delete-catalog": "delete_catalog",
    "--keep-catalog": "keep_catalog",
    "--force": "force",
    "--yes": "yes",
}


def parse_flags(tokens, stop_at_positional=False):
    """Consume flags. With `stop_at_positional` the first bare word ends the
    flag section and everything from there is the spawn command."""
    args = Args()
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            args.command = list(tokens[index + 1:])
            return args
        if token.startswith("--"):
            name, _, inline = token.partition("=")
            if name in _FLAGS_WITH_VALUE:
                if inline:
                    value = inline
                else:
                    index += 1
                    if index >= len(tokens):
                        raise UsageError("%s needs a value" % name)
                    value = tokens[index]
                _set_valued(args, name, value)
            elif name in _BOOL_FLAGS:
                setattr(args, _BOOL_FLAGS[name], True)
            elif name == "--no-plugins":
                args.plugins = False
            elif name == "--no-shared":
                args.shared = False
            elif name == "--help":
                raise HelpRequest("")
            else:
                raise UsageError("unknown option %s" % name)
            index += 1
            continue
        if token.startswith("-") and len(token) > 1:
            if token == "-h":
                raise HelpRequest("")
            if token == "-y":
                args.yes = True
                index += 1
                continue
            raise UsageError("unknown option %s" % token)
        if stop_at_positional:
            args.command = list(tokens[index:])
            return args
        args.rest.append(token)
        index += 1
    return args


def _set_valued(args, name, value):
    if name == "--agent":
        args.agent = value
    elif name == '--contributor':
        args.contributor = value
    elif name == "--url":
        args.url = value
    elif name == "--description":
        args.description = value
    else:
        key, _, val = value.partition("=")
        if not key or not val:
            raise UsageError("--env wants KEY=VALUE")
        args.env[key] = val


def options_from(args):
    return sync.Options(
        force_mcp=args.force_mcp, plugins=args.plugins, shared=args.shared, adopt=args.adopt
    )


# --------------------------------------------------------------------------
# sync
# --------------------------------------------------------------------------

def run_sync(args, subtitle="sync", quiet_banner=False, profile=None, extra=(),
             confirm=True):
    agents, missing, _explicit = sync.resolve_agents(args.agent)
    if not quiet_banner:
        banner.show(subtitle)
    profile = profile if profile is not None else profile_mod.Profile.load()
    if args.contributor is not None:
        profile.contributor = args.contributor
    state = state_mod.State.load()
    if args.adopt:
        adopt_undecided(profile, agents)
        if not args.dry_run:
            profile.save()
    reconciler = sync.Reconciler(
        profile, state, agents, options_from(args), missing=missing
    )
    changes = list(extra) + reconciler.plan()
    sync.show(changes)
    if args.dry_run:
        ui.say("")
        ui.say(ui.style("dry run: nothing was changed", "dim"))
        return 0
    # `sync` deletes symlinks and edits config, so it asks once — the same
    # question `init` asks. `--yes` and a non-terminal stdin skip it.
    if confirm and not args.yes and any(change.actionable for change in changes):
        if not ui.ask("\napply this?", True):
            ui.say("nothing changed")
            return 0
    failures = reconciler.apply(changes)
    if args.contributor is not None and not failures:
        profile.save()
    for change in failures:
        ui.warn("%s %s %s: %s" % (change.verb, change.kind, change.name, change.error))
    report_auth_hint(changes, failures)
    return 1 if failures else 0


def adopt_undecided(profile, agents):
    for agent in agents:
        entry = profile.agent(agent.name)
        for skill in catalog.skills():
            if entry.is_undecided("skills", skill.name):
                entry.allow("skills", skill.name)
        for mcp in catalog.mcps():
            if entry.is_undecided("mcp", mcp.name):
                entry.allow("mcp", mcp.name)
    for fragment in catalog.shell_fragments():
        if profile.is_shell_undecided(fragment.name):
            profile.allow_shell(fragment.name)


def report_auth_hint(changes, failures):
    """Only nag about OAuth for servers this run actually registered."""
    oauth = set(mcp.name for mcp in catalog.mcps() if mcp.is_oauth)
    failed = set(id(change) for change in failures)
    pending = sorted(set(
        change.name for change in changes
        if change.kind == "mcp" and change.verb in ("add", "update")
        and change.name in oauth and id(change) not in failed
    ))
    if pending:
        ui.say("")
        ui.say("next: ./install.sh mcp auth " + " ".join(pending))


def touch_profile(profile, kind, name, args, want):
    """Apply an add/remove to the profile.

    Naming agents with `--agent` is an explicit decision about those agents,
    so it may lift a deny (add) or write one (remove). Leaving `--agent` off
    is a global move: it never invents a refusal and never lifts one.
    """
    explicit = args.agent is not None
    if explicit:
        present, _missing, _ = sync.resolve_agents(args.agent)
        names = list(AGENT_NAMES) if args.agent.strip() == "all" \
            else [agent.name for agent in present]
    else:
        names = list(AGENT_NAMES)

    touched, refused = [], []
    for agent_name in names:
        entry = profile.agent(agent_name)
        if want:
            if explicit:
                entry.allow(kind, name)
                touched.append(agent_name)
            elif entry.is_denied(kind, name):
                refused.append(agent_name)
            else:
                entry.allow(kind, name)
                touched.append(agent_name)
        else:
            if explicit:
                entry.deny(kind, name)
            else:
                entry.unset(kind, name)
            touched.append(agent_name)

    if want and not touched and refused:
        ui.warn(
            "every agent denies %s, so this add changed nothing. Name them to "
            "lift it: --agent %s" % (name, ",".join(refused))
        )
    return touched


# --------------------------------------------------------------------------
# update
# --------------------------------------------------------------------------

def update(args):
    """Pull the checkout this installer is part of, then sync.

    The catalog is a working copy, so a skill you wrote or a group you moved
    is a git change like any other. A pull that would land on top of one stops
    and says so rather than choosing for you.

    Only `machine/` is looked at: this same checkout may be the app repo, and
    an edit under `src/` is none of the installer's business.
    """
    banner.show("update")
    root = paths.repo_root()
    machine = paths.machine_dir()

    git = probe.which("git")
    if git is None:
        ui.error("git is not on PATH, so there is nothing to pull")
        return 1
    if not os.path.exists(os.path.join(root, ".git")):
        ui.error("%s is not a git checkout, so there is nothing to pull"
                 % paths.tilde(root))
        return 1

    code, out = _git(git, root, "status", "--porcelain", "--", machine)
    if code != 0:
        ui.error("git status failed:\n" + out.rstrip())
        return 1
    if out.strip():
        ui.error("uncommitted changes under %s:" % paths.tilde(machine))
        for line in out.strip().splitlines():
            ui.say("  " + line.strip())
        ui.say("")
        ui.say("commit or stash them, then run update again")
        return 1

    # A branch with nowhere to pull from makes `git pull` print four lines of
    # advice about a situation the person reading did not choose to be in.
    if _git(git, root, "rev-parse", "--abbrev-ref", "@{u}")[0] != 0:
        _code, branch = _git(git, root, "rev-parse", "--abbrev-ref", "HEAD")
        branch = branch.strip() or "HEAD"
        where = paths.tilde(root)
        ui.error("%s is on %s, which has no upstream to pull from" % (where, branch))
        ui.say("  back to the default branch:")
        ui.say("    git -C %s checkout main" % where)
        ui.say("  or keep this one and track it:")
        ui.say("    git -C %s branch --set-upstream-to=origin/%s" % (where, branch))
        return 1

    ui.head("pull  " + paths.tilde(root))
    code, out = _git(git, root, "pull", "--ff-only")
    for line in (out or "").strip().splitlines():
        ui.say("  " + line)
    if code != 0:
        ui.say("")
        ui.error("pull failed; nothing was synced")
        return 1

    ui.say("")
    return run_sync(args, subtitle="update", quiet_banner=True)


def _git(git, root, *argv):
    completed = subprocess.run(
        [git, "-C", root] + list(argv),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True,
    )
    return completed.returncode, completed.stdout or ""


# --------------------------------------------------------------------------
# status
# --------------------------------------------------------------------------

def status(args):
    ui.head("catalog  " + paths.tilde(paths.catalog_dir()))
    for group in catalog.groups():
        names = ", ".join(member.name for member in group.members) or "empty"
        ui.say("  %-16s %s" % (group.name, names))

    ui.say("")
    ui.head("clis")
    for name in list(AGENT_NAMES) + ["gh"]:
        found = probe.which(name)
        ui.say("  %-8s %s" % (name, paths.tilde(found) if found else "not on PATH"))

    profile = profile_mod.Profile.load()
    ui.say("")
    where = (paths.tilde(paths.local_profile()) if profile.source == "local"
             else "none yet  (run ./install.sh init)")
    ui.head("profile  " + where)
    ui.say('  contributor  ' + profile.contributor)
    for agent_name in AGENT_NAMES:
        entry = profile.agent(agent_name)
        ui.say("  %-8s harness %s" % (agent_name, "on" if entry.harness else "off"))
        for kind in ("skills", "mcp"):
            ui.say("    %-6s allow  %s"
                   % (kind, ", ".join(entry.allow_list(kind)) or "-"))
            ui.say("    %-6s deny   %s"
                   % ("", ", ".join(entry.deny_list(kind)) or "-"))
    if profile.legacy_shell:
        ui.say("  shared   shell  every fragment  (pre-per-fragment profile)")
    else:
        ui.say("  shared   shell allow  %s"
               % (", ".join(profile.shared["shell_allow"]) or "-"))
        ui.say("           shell deny   %s"
               % (", ".join(profile.shared["shell_deny"]) or "-"))

    agents, missing, _ = sync.resolve_agents(args.agent)
    reconciler = sync.Reconciler(
        profile, state_mod.State.load(), agents, options_from(args), missing=missing
    )
    pending = [c for c in reconciler.plan() if c.verb != "keep"]
    ui.say("")
    ui.head("pending")
    if not pending:
        ui.say("  in sync")
    else:
        sync.show(pending)
    return 0
