"""`mcp auth` — log in, one at a time.

Auth is deliberately not part of `mcp add`. Adding a server writes config;
logging in opens a browser and blocks. Doing both in one command means a
`sync` that installs four servers throws four browser windows at you.

One agent at a time, all of its servers, then the next. The other order —
every agent for one server — makes you open Claude, quit, open Codex, quit,
open Grok, quit, and then open Claude again for the next server.

Only HTTP servers have anything to log in to, so Playwright and the other
stdio ones never appear here. Tokens land in each harness's own store; there
is no shared login across the three.
"""

import sys

from . import banner, catalog, profile as profile_mod, sync, ui
from .agents.base import AgentConfigError

DONE = "✓"
SKIPPED = "–"
FAILED = "✗"
MANUAL = "!"


def oauth_entries(name=None):
    entries = [entry for entry in catalog.mcps() if entry.is_oauth]
    if name is None:
        return entries, None
    match = [entry for entry in entries if entry.name == name]
    if match:
        return match, None
    known = catalog.find_mcp(name)
    if known is None:
        return [], "no MCP %r in the catalog" % name
    return [], "%s is a %s server; there is nothing to log in to" % (
        name, known.transport
    )


def run(name, args):
    banner.show("mcp auth")
    agents, missing, _explicit = sync.resolve_agents(args.agent)
    entries, problem = oauth_entries(name)
    if problem:
        ui.error(problem)
        return 1
    if not entries:
        ui.say("  no OAuth MCP servers in the catalog")
        return 0

    for agent_name in missing:
        ui.say("  %-7s %s" % ("skip", "%s: CLI not on PATH" % agent_name))
    if not agents:
        ui.say("  nothing to do: no agent CLI on PATH")
        return 0

    profile = profile_mod.Profile.load()
    interactive = sys.stdin.isatty()
    results = []

    for agent in agents:
        for entry in entries:
            results.append(_one(agent, entry, profile, args, interactive))

    _summary(results)
    if not interactive:
        ui.say("")
        ui.say(ui.style("stdin is not a terminal, so nothing was launched", "dim"))
    return 1 if any(mark == FAILED for _label, mark, _note in results) else 0


def _one(agent, entry, profile, args, interactive):
    """One (server, agent) pair. Returns (label, mark, note)."""
    label = "%s x %s" % (entry.name, agent.name)

    def out(mark, note):
        ui.say("  %s  %-24s %s" % (mark, label, ui.style(note, "dim")))
        return (label, mark, note)

    if profile.agent(agent.name).is_denied("mcp", entry.name):
        return out(SKIPPED, "denied in the profile")
    try:
        stored, _fingerprint = agent.mcp_get(entry.name)
    except AgentConfigError as exc:
        return out(SKIPPED, str(exc))
    if stored is None:
        return out(SKIPPED, "not registered yet; run sync first")
    if not args.force and agent.has_credentials(entry.name, entry.url) is True:
        return out(DONE, "already has a token; --force to redo")

    kind, payload = agent.auth_plan(entry.name)
    hint = " ".join(payload) if kind == "run" else "; ".join(payload)

    # Nothing to offer to run, so nothing to ask. Say where to go and move on.
    # Opening the agent here would put a full-screen program over this list,
    # and the list is the point: it is how you see what is left.
    if kind != "run":
        return out(MANUAL, hint)

    if not interactive:
        # Piped or scripted: no browser, but say what it would have taken.
        return out(SKIPPED, hint + "  (not a terminal)")

    if not ui.ask("  ?  " + label, default=True):
        return out(SKIPPED, "you said no")

    code, _output = agent.run(payload, capture=False)
    if code != 0:
        return out(FAILED, "%s exited %d" % (hint, code))
    return out(DONE, hint)


def _summary(results):
    if not results:
        return
    ui.say("")
    ui.head("  summary")
    for label, mark, _note in results:
        ui.say("    %s  %s" % (mark, label))
    left = [label for label, mark, _ in results if mark != DONE]
    if not left:
        ui.say("")
        ui.say(ui.style("    all authenticated", "dim"))
        return
    ui.say("")
    ui.say(ui.style("    still to do: " + ", ".join(left), "dim"))
    if any(mark == MANUAL for _label, mark, _note in results):
        ui.say(ui.style(
            "    %s is yours to do by hand; run `mcp auth` again to confirm"
            % MANUAL, "dim"))
