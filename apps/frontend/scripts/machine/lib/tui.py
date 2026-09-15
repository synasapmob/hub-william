"""`init` — the one command that asks questions.

Bare `./install.sh` is help. This draws the catalog as a three-level tree
(see `browse.py`), then hands the result to the very same `sync` the CLI runs,
so the preview and the confirm are identical whichever way you got here.

Nothing is written until you accept the preview: the browser edits a profile
held in memory, and `sync` plans against that.
"""

import os
import sys

from . import actions, banner, browse, catalog, keys, paths
from . import profile as profile_mod, sync, ui


def _interactive():
    return sys.stdin.isatty() and sys.stdout.isatty()


def run_init(args):
    banner.show("setup")

    agents, missing, _explicit = sync.resolve_agents(args.agent)
    if not agents:
        _report_clis()
        ui.error("no agent CLI on PATH; install claude, codex or grok first")
        return 1

    profile = profile_mod.Profile.load()
    # First run starts with everything ticked. After that the screen shows
    # what you last saved, because that is what is installed.
    browser = browse.Browser(profile, agents, catalog.groups(),
                             prefill_all=not profile.initialised)

    if args.yes or not _interactive():
        _report_clis()
        outcome = browse.SYNC
    else:
        outcome = _browse(browser)

    if outcome == browse.QUIT:
        ui.say("")
        ui.say("nothing changed")
        return 0

    browser.commit()
    if not args.dry_run:
        profile.save()
    code = actions.run_sync(
        args, subtitle="setup", quiet_banner=True, profile=profile
    )

    if not args.dry_run:
        ui.say("")
        ui.say("profile  " + paths.tilde(paths.local_profile()))
        ui.say("state    " + paths.tilde(paths.applied_file()))
        if profile.manages_zsh and os.path.isfile(paths.secrets_file()):
            ui.say("secrets  fill in " + paths.tilde(paths.secrets_file()))
    return code


def _browse(browser):
    try:
        return browser.run()
    except keys.Unsupported:
        _report_clis()
        return browse.browse_plain(browser)


def _report_clis():
    """What the browser draws at its top level, for the paths that skip it."""
    for line in browse.cli_block():
        ui.say(line)
    ui.say("")
