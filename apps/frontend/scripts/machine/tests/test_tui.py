"""The interactive path, driven through a real pty.

`--yes` covers the scripted path, but the three-level browser, the y/n prompts
and the apply confirm only run when stdin is a terminal. Those are exactly the
lines a person sees on a new machine, so they get exercised here rather than
trusted.

Keys are sent byte for byte: "\\x1b[B" really is a down arrow and " " really
is a toggle.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness import Machine  # noqa: E402

TIMEOUT = 60

DOWN = "\x1b[B"
UP = "\x1b[A"
RIGHT = "\x1b[C"
LEFT = "\x1b[D"
SPACE = " "
ENTER = "\r"


def drive(machine, argv, script, term="xterm-256color"):
    """Run install.sh on a pty, sending each entry of `script` in turn.

    Every send waits for the child to go quiet first, which keeps the exchange
    in step without hard-coding prompt text.
    """
    env = dict(os.environ)
    env.update({
        "HOME": machine.home,
        "PATH": machine.bin + ":/usr/bin:/bin",
        "FAKE_LOG": machine.calls,
        "NO_COLOR": "1",
        "TERM": term,
        "HUB_WILLIAM_PYTHON": sys.executable,
    })
    env.pop("HUB_WILLIAM_MACHINE_DIR", None)

    primary, secondary = pty.openpty()
    # A fresh pty has no window size, so give it one a real terminal would have.
    fcntl.ioctl(secondary, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
    process = subprocess.Popen(
        [os.path.join(machine.machine, "install.sh")] + list(argv),
        stdin=secondary, stdout=secondary, stderr=secondary,
        env=env, cwd=machine.machine, close_fds=True,
    )
    os.close(secondary)

    output = []
    pending = list(script)
    deadline = time.time() + TIMEOUT
    quiet_since = None

    try:
        while time.time() < deadline:
            ready, _, _ = select.select([primary], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(primary, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.append(chunk.decode("utf-8", "replace"))
                quiet_since = time.time()
                continue
            if process.poll() is not None:
                break
            # Only ever send after the child has printed something and then
            # gone quiet. Sending into the silence before the first draw can
            # land while the terminal is still line-buffered, and switching it
            # to character-at-a-time drops whatever was waiting there.
            if pending and quiet_since and time.time() - quiet_since > 0.35:
                os.write(primary, pending.pop(0).encode())
                quiet_since = None
        else:
            process.send_signal(signal.SIGKILL)
            raise AssertionError("timed out:\n" + "".join(output))
    finally:
        os.close(primary)

    process.wait(timeout=10)
    return process.returncode, "".join(output)


class TuiTest(unittest.TestCase):
    def setUp(self):
        self.m = Machine()
        self.addCleanup(self.m.cleanup)

    def zsh(self, name):
        return self.m.home_path(".zsh", name)

    # -- the lobby ---------------------------------------------------------
    def test_the_lobby_lists_the_clis_and_the_groups(self):
        code, out = drive(self.m, ["init"], ["q"])
        self.assertEqual(code, 0, out)
        self.assertIn("███ █ █ ██", out)          # the HUB WILLIAM wordmark
        self.assertIn("machine setup", out)
        self.assertIn("  cli", out)
        self.assertIn("claude", out)
        self.assertIn("  tools", out)
        for group in ("alias", "frontend-mcps", "general-mcps", "harness", "skills"):
            self.assertIn(group, out)
        # every catalog item is claimed by a group, so there is no `other` row
        self.assertNotIn("in no group", out)
        # never left the lobby, so ← was never on offer
        self.assertIn("→ open", out)
        self.assertNotIn("← back", out)
        self.assertIn("nothing changed", out)

    def test_q_quits_without_touching_anything(self):
        code, out = drive(self.m, ["init"], [SPACE, "q"])
        self.assertEqual(code, 0, out)
        self.assertIn("nothing changed", out)
        self.assertIsNone(self.m.profile())
        self.assertFalse(os.path.exists(self.m.home_path(".claude.json")))

    def test_enter_previews_then_applies(self):
        code, out = drive(self.m, ["init"], [ENTER, "y\n"])
        self.assertEqual(code, 0, out)
        self.assertIn("apply this?", out)
        self.assertIn("linear", self.m.claude_mcp())
        self.assertTrue(os.path.isfile(self.m.home_path(".claude", "CLAUDE.md")))
        self.assertFalse(os.path.islink(self.m.home_path(".claude", "CLAUDE.md")))
        self.assertTrue(os.path.islink(self.zsh("terminal.zsh")))
        self.assertIsNotNone(self.m.profile())

    def test_declining_the_preview_changes_nothing(self):
        code, out = drive(self.m, ["init"], [ENTER, "n\n"])
        self.assertEqual(code, 0, out)
        self.assertIn("nothing changed", out)
        self.assertFalse(os.path.exists(self.m.home_path(".claude.json")))

    # -- moving ------------------------------------------------------------
    def test_right_opens_a_group_and_left_comes_back(self):
        code, out = drive(self.m, ["init"], [RIGHT, LEFT, RIGHT, "q"])
        self.assertEqual(code, 0, out)
        self.assertIn("tools › alias", out)
        self.assertIn("dopa-tps.zsh", out)
        # back at the lobby the cli block is on screen again
        self.assertGreater(out.count("  cli"), 1)

    def test_left_does_nothing_on_the_first_page(self):
        """The lobby is the first page, so ← is a dead end rather than an exit."""
        code, out = drive(self.m, ["init"], [LEFT, LEFT, RIGHT, "q"])
        self.assertEqual(code, 0, out)
        self.assertIn("tools › alias", out)
        self.assertIn("nothing changed", out)

    def test_right_does_nothing_on_the_last_page(self):
        code, out = drive(
            self.m, ["init"], [DOWN, RIGHT, RIGHT, RIGHT, RIGHT, "q"]
        )
        self.assertEqual(code, 0, out)
        crumb = "tools › frontend-mcps › playwright"
        self.assertIn(crumb, out)
        self.assertNotIn(crumb + " ›", out)
        # redrawn once per keypress, so the extra rights kept it on this page
        self.assertGreaterEqual(out.count(crumb), 3)
        self.assertNotIn("→ agents", out.split(crumb)[-1])

    def test_an_empty_group_says_so_instead_of_refusing_to_open(self):
        self.m.write(self.m.catalog("groups.toml"),
                     '[frontend-skills]\ndescription = "later"\n')
        code, out = drive(self.m, ["init"], [RIGHT, "q"])
        self.assertEqual(code, 0, out)
        self.assertIn("tools › frontend-skills", out)
        self.assertIn("nothing here yet", out)

    # -- toggling ----------------------------------------------------------
    def test_space_on_a_group_turns_every_item_in_it_off(self):
        code, out = drive(self.m, ["init"], [SPACE, ENTER, "y\n"])
        self.assertEqual(code, 0, out)
        for name in ("terminal.zsh", "grok.zsh", "dopa-tps.zsh"):
            self.assertFalse(os.path.lexists(self.zsh(name)), name)
        self.assertEqual(sorted(self.m.profile()["shared"]["shell_deny"]),
                         ["dopa-tps.zsh", "grok.zsh", "terminal.zsh"])
        # the other groups were not on that row, so they went in untouched
        self.assertIn("linear", self.m.claude_mcp())

    def test_space_on_one_agent_denies_only_that_agent(self):
        """playwright off for claude and grok, still on for codex — then a
        sync of everything leaves codex alone with it."""
        code, out = drive(self.m, ["init"], [
            DOWN,       # frontend-mcps
            RIGHT,      # into it, cursor on playwright
            RIGHT,      # into playwright's agents, cursor on claude
            SPACE,      # claude off
            DOWN,       # codex — leave it on
            DOWN,       # grok
            SPACE,      # grok off
            ENTER,
            "y\n",
        ])
        self.assertEqual(code, 0, out)
        self.assertNotIn("playwright", self.m.claude_mcp())
        self.assertIn("playwright", self.m.agent_mcp("codex"))
        self.assertNotIn("playwright", self.m.agent_mcp("grok"))

        profile = self.m.profile()
        self.assertIn("playwright", profile["claude"]["mcp_deny"])
        self.assertIn("playwright", profile["grok"]["mcp_deny"])
        self.assertIn("playwright", profile["codex"]["mcp_allow"])

        # and a later sync of everything does not quietly put it back
        result = self.m.run("sync", "--yes")
        self.assertEqual(result.code, 0, result)
        self.assertNotIn("playwright", self.m.claude_mcp())
        self.assertIn("playwright", self.m.agent_mcp("codex"))

    def test_a_shell_fragment_stops_at_the_group(self):
        """A fragment is one switch for the machine, so there is no agent
        level under it and → says nothing on offer."""
        code, out = drive(self.m, ["init"], [RIGHT, RIGHT, RIGHT, "q"])
        self.assertEqual(code, 0, out)
        self.assertIn("tools › alias", out)
        self.assertIn("machine-wide", out)
        self.assertNotIn("tools › alias › ", out)
        self.assertNotIn("→ agents", out)

    def test_n_clears_the_lobby_and_a_ticks_it_all_back(self):
        code, out = drive(self.m, ["init"], ["n", "a", ENTER, "y\n"])
        self.assertEqual(code, 0, out)
        profile = self.m.profile()
        self.assertIn("playwright", profile["claude"]["mcp_allow"])
        self.assertIn("chrome-devtools", profile["claude"]["mcp_allow"])
        self.assertEqual(profile["claude"]["mcp_deny"], [])

    def test_a_second_init_starts_from_what_you_saved(self):
        self.assertEqual(self.m.run("init", "--yes").code, 0)
        self.assertEqual(
            self.m.run("mcp", "remove", "chrome-devtools", "--agent", "all",
                       "--keep-catalog").code, 0)

        code, out = drive(self.m, ["init"], ["q"])
        self.assertEqual(code, 0, out)
        # playwright on, chrome-devtools off: the group is half ticked
        self.assertIn("[~] frontend-mcps", out)
        self.assertIn("[x] general-mcps", out)

    def test_first_run_starts_with_everything_ticked(self):
        code, out = drive(self.m, ["init"], ["q"])
        self.assertEqual(code, 0, out)
        for group in ("alias", "frontend-mcps", "general-mcps", "harness", "skills"):
            self.assertIn("[x] " + group, out)

    def test_nothing_to_do_is_not_a_wall_of_keep_lines(self):
        self.assertEqual(self.m.run("init", "--yes").code, 0)
        code, out = drive(self.m, ["init"], [ENTER])
        self.assertEqual(code, 0, out)
        self.assertIn("nothing to do", out)
        self.assertNotIn("keep  ", out)
        self.assertNotIn("apply this?", out)

    def test_the_confirm_takes_one_keypress(self):
        code, out = drive(self.m, ["init"], [ENTER, "y"])   # no newline
        self.assertEqual(code, 0, out)
        self.assertIn("linear", self.m.claude_mcp())

    def test_a_dumb_terminal_falls_back_to_typed_numbers(self):
        """No cbreak on a dumb terminal, so the three levels collapse into one
        typed screen rather than printing escape codes at you."""
        code, out = drive(self.m, ["init"], ["1\n", "s\n", "y\n"], term="dumb")
        self.assertEqual(code, 0, out)
        self.assertIn("numbers to toggle", out)
        self.assertNotIn("\x1b[", out)

        # 1 is `alias`, which was on, so it went off
        for name in ("terminal.zsh", "grok.zsh", "dopa-tps.zsh"):
            self.assertFalse(os.path.lexists(self.zsh(name)), name)
        self.assertIn("linear", self.m.claude_mcp())

    # -- sync asks too ------------------------------------------------------
    def test_sync_asks_before_it_applies(self):
        # --adopt, because before `init` nothing has been decided and a bare
        # sync has nothing to offer.
        code, out = drive(self.m, ["sync", "--adopt"], ["n\n"])
        self.assertEqual(code, 0, out)
        self.assertIn("apply this?", out)
        self.assertIn("nothing changed", out)
        self.assertFalse(os.path.exists(self.m.home_path(".claude.json")))

    def test_sync_applies_when_you_say_yes(self):
        code, out = drive(self.m, ["sync", "--adopt"], ["y\n"])
        self.assertEqual(code, 0, out)
        self.assertIn("linear", self.m.claude_mcp())

    # -- mcp auth -----------------------------------------------------------
    def test_auth_finishes_one_agent_before_moving_on(self):
        """The other order makes you open Claude, quit, open Codex, quit, open
        Grok, quit — and then open Claude again for the next server."""
        self.assertEqual(self.m.run("init", "--yes").code, 0)
        # One `n` per (OAuth server, prompting agent). Grok has no login
        # command so it never asks. Generous on purpose: unsent answers are
        # dropped when the child exits, but running out of them hangs.
        code, out = drive(self.m, ["mcp", "auth"], ["n"] * 12)
        self.assertEqual(code, 0, out)
        self.assertLess(out.index("notion x claude"), out.index("linear x codex"))
        self.assertLess(out.index("notion x codex"), out.index("linear x grok"))

    def test_yes_runs_the_login_command_for_the_agents_that_have_one(self):
        self.assertEqual(self.m.run("init", "--yes").code, 0)
        code, out = drive(self.m, ["mcp", "auth", "linear"], ["y", "y"])
        self.assertEqual(code, 0, out)

        calls = "\n".join(self.m.cli_calls())
        self.assertIn("claude mcp login linear", calls)
        self.assertIn("codex mcp login linear", calls)
        # grok has none, so nothing was launched for it — just a note
        self.assertNotIn("grok mcp login", calls)
        self.assertIn("no login command", out)
        self.assertIn("summary", out)

    def test_declining_marks_it_and_says_what_is_left(self):
        self.assertEqual(self.m.run("init", "--yes").code, 0)
        code, out = drive(self.m, ["mcp", "auth", "linear"], ["n", "n"])
        self.assertEqual(code, 0, out)
        self.assertIn("you said no", out)
        self.assertIn("still to do", out)
        self.assertIn("linear x grok", out)
        self.assertIn("yours to do by hand", out)
        # Reading auth state shells out to `mcp list`; saying no must still
        # mean no browser, which is `mcp login`.
        self.assertEqual(
            [call for call in self.m.cli_calls() if "login" in call], []
        )


if __name__ == "__main__":
    unittest.main()
