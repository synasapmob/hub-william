"""End-to-end tests. Every one of them runs ./install.sh against a temp HOME.

The seven numbered cases come straight from machine/harness_guiline.md and
are marked as such; the rest cover the merge rules around them.
"""

import os
import re
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness import Machine  # noqa: E402


class MachineTest(unittest.TestCase):
    clis = ("claude", "codex", "grok", "gh")

    def setUp(self):
        self.m = Machine(clis=self.clis)
        self.addCleanup(self.m.cleanup)

    def init(self, *extra):
        result = self.m.run("init", "--yes", *extra)
        self.assertEqual(result.code, 0, result)
        return result


class TestHelp(MachineTest):
    def test_bare_invocation_is_banner_plus_help(self):
        result = self.m.run()
        self.assertEqual(result.code, 0, result)
        self.assertIn("███ █ █ ██", result.out)   # the HUB WILLIAM wordmark
        self.assertIn("machine setup", result.out)
        self.assertIn("usage: ./install.sh", result.out)

    def test_a_narrow_terminal_gets_plain_text_not_a_wrapped_wordmark(self):
        from lib import banner
        self.assertIn("███", banner.render("setup", color=False, columns=80))
        narrow = banner.render("setup", color=False, columns=30)
        self.assertNotIn("█", narrow)
        self.assertIn("HUB WILLIAM", narrow)

    def test_a_dry_run_writes_neither_profile_nor_home(self):
        result = self.m.run("init", "--yes", "--dry-run")
        self.assertEqual(result.code, 0, result)
        self.assertIn("dry run: nothing was changed", result.out)
        self.assertIsNone(self.m.profile())
        self.assertIsNone(self.m.applied())
        self.assertFalse(os.path.exists(self.m.home_path(".claude.json")))
        self.assertFalse(os.path.lexists(self.m.home_path(".zsh")))

    def test_unknown_command_is_a_usage_error(self):
        result = self.m.run("frobnicate")
        self.assertEqual(result.code, 2, result)


class TestSyncIsADelta(MachineTest):
    def test_second_sync_is_a_no_op(self):
        """Plan test 1."""
        first = self.init()
        self.assertIn("add", first.out)

        before = {
            "claude": self.m.read(self.m.home_path(".claude.json")),
            "codex": self.m.read(self.m.home_path(".codex", "config.toml")),
            "grok": self.m.read(self.m.home_path(".grok", "config.toml")),
            "zshrc": self.m.read(self.m.home_path(".zshrc")),
        }

        second = self.m.run("sync")
        self.assertEqual(second.code, 0, second)
        for line in second.out.splitlines():
            self.assertNotIn("add     ", line, second)
            self.assertNotIn("update  ", line, second)
            self.assertNotIn("remove  ", line, second)

        self.assertEqual(before["claude"], self.m.read(self.m.home_path(".claude.json")))
        self.assertEqual(before["codex"],
                         self.m.read(self.m.home_path(".codex", "config.toml")))
        self.assertEqual(before["grok"],
                         self.m.read(self.m.home_path(".grok", "config.toml")))
        self.assertEqual(before["zshrc"], self.m.read(self.m.home_path(".zshrc")))

    def test_status_says_in_sync_after_init(self):
        self.init()
        result = self.m.run("status")
        self.assertEqual(result.code, 0, result)
        self.assertIn("in sync", result.out)


class TestSkills(MachineTest):
    def test_user_owned_skill_dir_survives_remove(self):
        """Plan test 2."""
        mine = self.m.home_path(".claude", "skills", "frontend-verify")
        self.m.write(os.path.join(mine, "SKILL.md"), "# mine, not yours\n")

        self.init()
        self.assertFalse(os.path.islink(mine))
        self.assertIn("a real file is there", self.init().out)

        result = self.m.run("skill", "remove", "frontend-verify")
        self.assertEqual(result.code, 0, result)
        self.assertTrue(os.path.isdir(mine))
        self.assertEqual(self.m.read(os.path.join(mine, "SKILL.md")),
                         "# mine, not yours\n")

    def test_foreign_symlink_is_left_alone(self):
        elsewhere = self.m.write(
            os.path.join(self.m.root, "other", "SKILL.md"), "# elsewhere\n"
        )
        link = self.m.skill_link("claude", "frontend-verify")
        os.makedirs(os.path.dirname(link))
        os.symlink(os.path.dirname(elsewhere), link)

        result = self.init()
        self.assertIn("a symlink you made", result.out)
        self.assertEqual(os.path.realpath(link),
                         os.path.realpath(os.path.dirname(elsewhere)))

    def test_a_link_pointing_at_something_gone_is_repaired(self):
        """Move the checkout and every link it made dangles. A link that does
        not resolve is doing nobody's job, so it is ours to fix — otherwise
        every name it once owned is reported as yours, forever."""
        link = self.m.skill_link("claude", "frontend-verify")
        os.makedirs(os.path.dirname(link))
        os.symlink(os.path.join(self.m.root, "gone", "frontend-verify"), link)
        self.assertTrue(os.path.islink(link))
        self.assertFalse(os.path.exists(link))

        result = self.init()
        self.assertIn("pointed at something that is gone", result.out)
        self.assertTrue(os.path.isdir(link))
        self.assertFalse(os.path.islink(link))
        self.assertIn("name: frontend-verify", self.m.read(
            os.path.join(link, "SKILL.md")
        ))

    def test_missing_codex_still_updates_claude(self):
        """Plan test 3."""
        self.m.drop_cli("codex")
        self.init()
        self.assertTrue(os.path.isdir(self.m.skill_link("claude", "frontend-verify")))
        self.assertFalse(os.path.islink(
            self.m.skill_link("claude", "frontend-verify")
        ))
        self.assertFalse(os.path.lexists(self.m.skill_link("codex", "frontend-verify")))

        result = self.m.run("skill", "add", "supabase-remote")
        self.assertEqual(result.code, 0, result)
        self.assertTrue(os.path.isdir(self.m.skill_link("claude", "supabase-remote")))
        self.assertIn("CLI not on PATH", result.out)

    def test_scoped_remove_denies_only_that_agent(self):
        self.init()
        result = self.m.run("skill", "remove", "frontend-verify", "--agent", "codex")
        self.assertEqual(result.code, 0, result)

        self.assertTrue(os.path.isdir(self.m.skill_link("claude", "frontend-verify")))
        self.assertFalse(os.path.lexists(self.m.skill_link("codex", "frontend-verify")))
        profile = self.m.profile()
        self.assertIn("frontend-verify", profile["codex"]["skills_deny"])
        self.assertNotIn("frontend-verify", profile["claude"]["skills_deny"])

    def test_global_add_does_not_lift_a_deny(self):
        self.init()
        self.m.run("skill", "remove", "frontend-verify", "--agent", "codex")
        result = self.m.run("skill", "add", "frontend-verify")
        self.assertEqual(result.code, 0, result)

        self.assertFalse(os.path.lexists(self.m.skill_link("codex", "frontend-verify")))
        self.assertIn("frontend-verify", self.m.profile()["codex"]["skills_deny"])

    def test_naming_the_agent_lifts_the_deny(self):
        self.init()
        self.m.run("skill", "remove", "frontend-verify", "--agent", "codex")
        result = self.m.run("skill", "add", "frontend-verify", "--agent", "codex")
        self.assertEqual(result.code, 0, result)

        self.assertTrue(os.path.isdir(self.m.skill_link("codex", "frontend-verify")))
        self.assertNotIn("frontend-verify", self.m.profile()["codex"]["skills_deny"])

    def test_global_remove_uninstalls_everywhere_without_denying(self):
        self.init()
        result = self.m.run("skill", "remove", "frontend-verify")
        self.assertEqual(result.code, 0, result)
        for agent in ("claude", "codex", "grok"):
            self.assertFalse(os.path.lexists(self.m.skill_link(agent, "frontend-verify")))
        profile = self.m.profile()
        self.assertNotIn("frontend-verify", profile["claude"]["skills_allow"])
        self.assertNotIn("frontend-verify", profile["claude"]["skills_deny"])

        # ...and a later sync does not quietly bring it back.
        self.m.run("sync")
        self.assertFalse(os.path.lexists(self.m.skill_link("claude", "frontend-verify")))

    def test_adding_an_unknown_skill_is_a_usage_error(self):
        result = self.m.run("skill", "add", "no-such-skill")
        self.assertEqual(result.code, 2, result)
        self.assertIn("no skill", result.out)

    def test_delete_catalog_removes_the_source(self):
        self.init()
        result = self.m.run("skill", "remove", "supabase-remote", "--delete-catalog")
        self.assertEqual(result.code, 0, result)
        self.assertFalse(os.path.isdir(self.m.library("skills", "supabase-remote")))
        self.assertFalse(os.path.lexists(self.m.skill_link("grok", "supabase-remote")))


class TestMcp(MachineTest):
    def test_deny_survives_a_global_remove_and_re_add(self):
        """Plan test 4."""
        self.init()
        self.m.run("mcp", "remove", "playwright", "--agent", "codex")
        self.assertNotIn("playwright", self.m.agent_mcp("codex"))

        self.m.run("mcp", "remove", "playwright")
        self.assertFalse(os.path.isfile(self.m.catalog("mcp", "playwright.toml")))
        self.assertNotIn("playwright", self.m.agent_mcp("claude"))

        result = self.m.run("mcp", "add", "playwright", "npx", "@playwright/mcp@latest")
        self.assertEqual(result.code, 0, result)
        self.assertTrue(os.path.isfile(self.m.catalog("mcp", "playwright.toml")))
        self.assertIn("playwright", self.m.agent_mcp("claude"))
        self.assertNotIn("playwright", self.m.agent_mcp("codex"))
        self.assertIn("playwright", self.m.profile()["codex"]["mcp_deny"])

    def test_user_edited_block_is_not_deleted(self):
        """Plan test 5."""
        self.init()
        config = self.m.home_path(".codex", "config.toml")
        text = self.m.read(config)
        self.assertIn("[mcp_servers.playwright]", text)
        self.m.write(config, text.replace(
            '[mcp_servers.playwright]\ncommand = "npx"',
            '[mcp_servers.playwright]\nenv = { PWDEBUG = "1" }\ncommand = "npx"',
        ))

        result = self.m.run("mcp", "remove", "playwright")
        self.assertEqual(result.code, 0, result)
        self.assertIn("you edited this block", result.out)
        after = self.m.read(config)
        self.assertIn("PWDEBUG", after)
        self.assertIn("[mcp_servers.playwright]", after)
        # Claude's copy, which we did own, is gone.
        self.assertNotIn("playwright", self.m.claude_mcp())

    def test_the_same_server_under_your_name_is_not_added_again(self):
        """Grok keys credentials by `<name>:<url>`, so a second entry for a
        server you already authenticated asks you to log in again — and looks
        for all the world like the login failed."""
        self.m.write(self.m.home_path(".grok", "config.toml"), "\n".join([
            "[mcp_servers.notion-mcp]",
            'url = "https://mcp.notion.com/mcp"',
            "enabled = true",
            "",
        ]))
        result = self.init()

        line = result.line_for("grok", "mcp", "notion")
        self.assertIn("already here as `notion-mcp`", line, result)
        self.assertNotIn("notion", self.m.toml_mcp("grok"))
        self.assertIn("notion-mcp", self.m.toml_mcp("grok"))
        # the other agents had no such entry, so they got it as usual
        self.assertIn("notion", self.m.claude_mcp())
    def test_force_mcp_removes_a_block_the_state_file_no_longer_claims(self):
        """Without `applied.json` nothing is ours, so a deny becomes a report
        you cannot act on. A symlink proves itself by where it points; a config
        block cannot, so the same flag that overrides ownership when writing
        has to work when removing."""
        self.init()
        self.assertIn("linear", self.m.claude_mcp())
        os.unlink(self.m.machine_path("state", "applied.json"))

        blocked = self.m.run("mcp", "remove", "linear", "--agent", "claude", "--yes")
        self.assertEqual(blocked.code, 0, blocked)
        self.assertIn("--force-mcp to remove it anyway", blocked.out)
        self.assertIn("linear", self.m.claude_mcp())

        forced = self.m.run("mcp", "remove", "linear", "--agent", "claude",
                            "--force-mcp", "--yes")
        self.assertEqual(forced.code, 0, forced)
        self.assertNotIn("linear", self.m.claude_mcp())
        # scoped to the agent named, as always
        self.assertIn("linear", self.m.toml_mcp("codex"))

    def test_pre_existing_identical_block_is_left_alone(self):
        self.m.write(self.m.home_path(".codex", "config.toml"), "\n".join([
            "model = \"gpt-5.6-sol\"",
            "",
            "[mcp_servers.linear]",
            "url = \"https://mcp.linear.app/mcp\"",
            "",
        ]))
        result = self.init()
        # Nothing to move, so the preview does not mention it at all.
        self.assertIsNone(result.line_for("codex", "mcp", "linear"), result)
        text = self.m.read(self.m.home_path(".codex", "config.toml"))
        self.assertIn('model = "gpt-5.6-sol"', text)
        self.assertIn('[mcp_servers.linear]', text)
        self.assertNotIn("hub william machine: mcp linear", text)

    def test_different_block_is_reported_not_overwritten(self):
        self.m.write(self.m.home_path(".codex", "config.toml"), "\n".join([
            "[mcp_servers.playwright]",
            'command = "bunx"',
            'args = ["@playwright/mcp"]',
            "",
        ]))
        result = self.init()
        self.assertIn("already configured, not by us", result.out)
        self.assertEqual(self.m.toml_mcp("codex")["playwright"]["command"], "bunx")

        forced = self.m.run("sync", "--force-mcp")
        self.assertEqual(forced.code, 0, forced)
        self.assertEqual(self.m.toml_mcp("codex")["playwright"]["command"], "npx")

    def test_surrounding_config_survives_the_merge(self):
        original = "\n".join([
            "model = \"gpt-5.6-sol\"",
            "",
            "# codex needs the folder trusted",
            '[projects."/Users/me/work"]',
            'trust_level = "trusted"',
            "",
            "[otel]",
            'exporter = { otlp-http = { endpoint = "https://x/y", protocol = "json" } }',
            "",
        ])
        self.m.write(self.m.home_path(".codex", "config.toml"), original)
        self.init()
        after = self.m.read(self.m.home_path(".codex", "config.toml"))
        for fragment in ('model = "gpt-5.6-sol"', "# codex needs the folder trusted",
                         '[projects."/Users/me/work"]', "otlp-http"):
            self.assertIn(fragment, after)
        self.assertIn("[mcp_servers.linear]", after)

        self.m.run("mcp", "remove", "linear")
        cleaned = self.m.read(self.m.home_path(".codex", "config.toml"))
        self.assertNotIn("[mcp_servers.linear]", cleaned)
        for fragment in ('model = "gpt-5.6-sol"', "# codex needs the folder trusted",
                         "otlp-http"):
            self.assertIn(fragment, cleaned)

    def test_grok_blocks_are_enabled(self):
        self.init()
        self.assertIs(self.m.toml_mcp("grok")["linear"]["enabled"], True)

    def test_add_with_url_writes_a_catalog_entry_without_tokens(self):
        self.init()
        result = self.m.run("mcp", "add", "context7", "--url", "https://mcp.context7.com/mcp")
        self.assertEqual(result.code, 0, result)
        self.assertEqual(self.m.claude_mcp()["context7"],
                         {"type": "http", "url": "https://mcp.context7.com/mcp"})
        catalog = self.m.read(self.m.catalog("mcp", "context7.toml"))
        self.assertIn("https://mcp.context7.com/mcp", catalog)
        self.assertNotIn("Bearer", catalog)

    def test_a_global_add_says_so_when_every_agent_denies(self):
        """Unticking in `init` writes the same deny this remove does, and a
        global add is not allowed to lift either of them."""
        self.init()
        self.m.run("mcp", "remove", "chrome-devtools", "--agent", "all",
                   "--keep-catalog")
        self.assertIn("chrome-devtools", self.m.profile()["claude"]["mcp_deny"])

        result = self.m.run("mcp", "add", "chrome-devtools",
                            "--", "npx", "-y", "chrome-devtools-mcp")
        self.assertEqual(result.code, 0, result)
        self.assertNotIn("chrome-devtools", self.m.claude_mcp())
        self.assertIn("every agent denies chrome-devtools", result.out)

        lifted = self.m.run("mcp", "add", "chrome-devtools", "--agent", "claude")
        self.assertEqual(lifted.code, 0, lifted)
        self.assertIn("chrome-devtools", self.m.claude_mcp())
        self.assertNotIn("chrome-devtools", self.m.agent_mcp("codex"))

    def test_double_dash_separates_flags_from_the_command(self):
        self.init()
        result = self.m.run(
            "mcp", "add", "pw2", "--agent", "claude", "--", "npx", "-y", "@playwright/mcp"
        )
        self.assertEqual(result.code, 0, result)
        self.assertEqual(self.m.claude_mcp()["pw2"]["args"], ["-y", "@playwright/mcp"])
        self.assertNotIn("pw2", self.m.agent_mcp("codex"))

    def test_undecided_items_are_reported_not_installed(self):
        self.m.run("sync")
        result = self.m.run("sync")
        self.assertIn("undecided", result.out)
        self.assertNotIn("chrome-devtools", self.m.claude_mcp())

    def test_adopt_takes_the_undecided_ones(self):
        """Before init there is no profile at all, so everything is undecided
        rather than denied, and sync leaves it alone until you say."""
        self.m.run("sync")
        self.assertNotIn("chrome-devtools", self.m.claude_mcp())
        result = self.m.run("sync", "--adopt")
        self.assertEqual(result.code, 0, result)
        self.assertIn("chrome-devtools", self.m.claude_mcp())
        self.assertIn("chrome-devtools", self.m.profile()["claude"]["mcp_allow"])


class TestUpdateAndBootstrap(MachineTest):
    """`boot.sh` puts a checkout in ~/.hub-william; `update` pulls it and
    syncs. That pair is the only place the installer shells out to git."""

    def as_checkout(self, status=""):
        """A fake git on PATH, and a .git so repo_root() looks like a clone."""
        body = ""
        if status:
            body = 'case "$*" in *status*) echo "%s" ;; esac\n' % status
        self.m.add_cli("git", body)
        checkout = os.path.join(self.m.root, ".git")
        if not os.path.isdir(checkout):
            os.makedirs(checkout)

    def test_update_pulls_then_syncs(self):
        self.init()
        self.as_checkout()
        result = self.m.run("update", "--yes")
        self.assertEqual(result.code, 0, result)
        self.assertIn("machine update", result.out)
        self.assertIn("pull --ff-only", "\n".join(self.m.cli_calls()))

    def test_update_refuses_to_pull_onto_your_own_edits(self):
        self.init()
        self.as_checkout(status=" M machine/registries/groups.toml")
        result = self.m.run("update", "--yes")
        self.assertEqual(result.code, 1, result)
        self.assertIn("uncommitted changes", result.out)
        self.assertIn("machine/registries/groups.toml", result.out)
        self.assertNotIn("pull --ff-only", "\n".join(self.m.cli_calls()))

    def test_update_on_a_branch_with_no_upstream_says_where_to_go(self):
        """Otherwise `git pull` answers with four lines of advice about a
        situation the person reading did not choose to be in."""
        self.init()
        self.as_checkout()
        self.m.add_cli("git", 'case "$*" in\n'
                              '  *"@{u}"*) exit 1 ;;\n'
                              '  *rev-parse*) echo scratch ;;\n'
                              'esac\n')
        result = self.m.run("update", "--yes")
        self.assertEqual(result.code, 1, result)
        self.assertIn("no upstream", result.out)
        self.assertIn("checkout main", result.out)
        self.assertNotIn("pull --ff-only", "\n".join(self.m.cli_calls()))

    def test_update_outside_a_checkout_says_so(self):
        self.init()
        result = self.m.run("update", "--yes")
        self.assertEqual(result.code, 1, result)
        self.assertIn("not a git checkout", result.out)

    def test_boot_sh_is_valid_shell_and_hands_over_a_terminal(self):
        path = self.m.machine_path("boot.sh")
        self.assertEqual(subprocess.call(["sh", "-n", path]), 0)
        text = self.m.read(path)
        self.assertIn("Southern-Discoveries/hub-william", text)
        self.assertIn("sparse-checkout set --no-cone", text)
        # piped to sh, stdin is the script itself; without this the installer
        # sees no terminal and stops asking
        self.assertIn("/dev/tty", text)
        self.assertNotIn("ghp_", text)

    def test_boot_sh_runs_the_command_you_gave_it(self):
        """`... | sh -s -- sync` has to reach the installer, or the one-liner
        is only ever an install and never an update."""
        path = self.m.machine_path("boot.sh")
        fake = os.path.join(self.m.root, "fakehome")
        os.makedirs(os.path.join(fake, "scripts", "machine"))
        installer = os.path.join(fake, "scripts", "machine", "install.sh")
        self.m.write(installer, '#!/bin/sh\necho "installer got: $*"\n')
        os.chmod(installer, 0o755)
        os.makedirs(os.path.join(fake, ".git"))
        self.m.add_cli("git")
        self.m.add_cli("gh")

        env = dict(os.environ)
        env.update({"HUB_WILLIAM_HOME": fake, "PATH": self.m.bin + ":/usr/bin:/bin",
                    "FAKE_LOG": self.m.calls})
        out = subprocess.check_output(
            ["sh", path, "sync", "--dry-run"], env=env, universal_newlines=True,
            stderr=subprocess.STDOUT,
        )
        # stdout is a pipe here, so it prints the command rather than running it
        self.assertIn("sync --dry-run", out)
        self.assertNotIn("installer got: init", out)


class TestGroups(MachineTest):
    """`catalog/groups.toml` is what `init` shows. It is data: nothing in lib/
    knows these names."""

    def test_status_lists_the_groups_and_their_members(self):
        result = self.m.run("status")
        self.assertEqual(result.code, 0, result)
        self.assertIn("alias", result.out)
        self.assertIn("dopa-tps.zsh", result.line_for("alias"))
        self.assertIn("playwright", result.line_for("frontend-mcps"))
        self.assertIn("notion", result.line_for("general-mcps"))

    def test_a_name_no_group_claims_still_shows_up(self):
        """An item can never be installed by sync while invisible in init."""
        self.m.write(self.m.catalog("groups.toml"),
                     '[general-mcps]\nmcp = ["linear"]\n')
        result = self.m.run("status")
        self.assertEqual(result.code, 0, result)
        other = result.line_for("other")
        for name in ("notion", "playwright", "terminal.zsh", "AGENTS.md"):
            self.assertIn(name, other)

    def test_a_group_may_name_something_not_written_yet(self):
        self.m.write(self.m.catalog("groups.toml"),
                     '[backend-mcps]\nmcp = ["postgres"]\n')
        result = self.m.run("status")
        self.assertEqual(result.code, 0, result)
        self.assertIn("postgres", result.line_for("backend-mcps"))

        applied = self.init()
        self.assertNotIn("postgres", applied.out.replace("backend-mcps", ""))

    def test_a_broken_groups_file_is_an_error_not_a_traceback(self):
        self.m.write(self.m.catalog("groups.toml"), "[alias\n")
        result = self.m.run("status")
        self.assertEqual(result.code, 1, result)
        self.assertIn("groups.toml", result.out)
        self.assertNotIn("Traceback", result.out)


class TestHarnessAndZsh(MachineTest):
    def test_legacy_catalog_symlinks_migrate_to_generated_copies(self):
        harness = self.m.home_path(".claude", "CLAUDE.md")
        skill = self.m.skill_link("claude", "frontend-verify")
        os.makedirs(os.path.dirname(harness))
        os.makedirs(os.path.dirname(skill))
        os.symlink(self.m.library("harness", "AGENTS.md"), harness)
        os.symlink(self.m.library("skills", "frontend-verify"), skill)

        result = self.init()

        self.assertEqual(result.code, 0, result)
        self.assertFalse(os.path.islink(harness))
        self.assertFalse(os.path.islink(skill))
        self.assertTrue(os.path.isfile(harness))
        self.assertTrue(os.path.isfile(os.path.join(skill, "SKILL.md")))
        self.assertFalse(any(
            name.startswith("CLAUDE.md.before-hub-william-harness-")
            for name in os.listdir(os.path.dirname(harness))
        ))

    def test_harness_is_generated_read_only_into_every_home(self):
        self.init()
        for agent, filename in (("claude", "CLAUDE.md"), ("codex", "AGENTS.md"),
                                ("grok", "AGENTS.md")):
            link = self.m.home_path("." + agent, filename)
            self.assertTrue(os.path.isfile(link), link)
            self.assertFalse(os.path.islink(link), link)
            self.assertTrue(self.m.read(link).startswith(
                "<!-- hub-william-generated: DO NOT EDIT;"
            ))
            self.assertFalse(os.stat(link).st_mode & 0o222)

    def test_a_previous_global_harness_is_replaced_and_backed_up(self):
        self.m.write(self.m.home_path(".claude", "CLAUDE.md"), "# mine\n")
        result = self.init()
        link = self.m.home_path(".claude", "CLAUDE.md")
        self.assertIn("replacing previous global harness", result.out)
        self.assertTrue(os.path.isfile(link))
        self.assertFalse(os.path.islink(link))
        backups = [
            name for name in os.listdir(self.m.home_path(".claude"))
            if name.startswith("CLAUDE.md.before-hub-william-harness-")
        ]
        self.assertEqual(len(backups), 1)
        self.assertEqual(
            self.m.read(self.m.home_path(".claude", backups[0])), "# mine\n"
        )

    def test_a_foreign_global_harness_symlink_is_replaced_and_backed_up(self):
        old = self.m.write(os.path.join(self.m.root, "old-agents.md"), "# old\n")
        link = self.m.home_path(".codex", "AGENTS.md")
        os.makedirs(os.path.dirname(link))
        os.symlink(old, link)

        result = self.init()

        self.assertIn("replacing previous global harness", result.out)
        self.assertTrue(os.path.isfile(link))
        self.assertFalse(os.path.islink(link))
        backups = [
            name for name in os.listdir(self.m.home_path(".codex"))
            if name.startswith("AGENTS.md.before-hub-william-harness-")
        ]
        self.assertEqual(len(backups), 1)
        self.assertTrue(os.path.islink(self.m.home_path(".codex", backups[0])))

    def test_sync_repairs_edited_generated_harness_and_skill(self):
        self.init()
        harness = self.m.home_path(".codex", "AGENTS.md")
        skill = os.path.join(
            self.m.skill_link("codex", "frontend-verify"), "SKILL.md"
        )
        expected_harness = self.m.read(harness)
        expected_skill = self.m.read(skill)
        os.chmod(harness, 0o644)
        os.chmod(skill, 0o644)
        self.m.write(harness, "# edited installed output\n")
        self.m.write(skill, "# edited installed output\n")

        result = self.m.run("sync", "--yes")

        self.assertEqual(result.code, 0, result)
        self.assertIn("regenerating managed copy", result.out)
        self.assertEqual(self.m.read(harness), expected_harness)
        self.assertEqual(self.m.read(skill), expected_skill)
        self.assertFalse(os.stat(harness).st_mode & 0o222)
        self.assertFalse(os.stat(skill).st_mode & 0o222)

    def test_global_harness_contains_the_personal_tag_contract(self):
        root_text = self.m.read(self.m.library("harness", "AGENTS.md"))
        tag_files = (
            "answer.md", "report.md", "plan.md", "delivery.md",
            "delivery-verify.md", "worktree.md", "ignore.md", "linear.md", "rebase.md", "draft.md",
            "mergeable.md", "merge.md", "playwright.md",
        )
        tag_dir = self.m.library("harness", "tags")
        self.assertEqual(
            sorted(name for name in os.listdir(tag_dir) if name.endswith(".md")),
            sorted(tag_files),
        )
        self.assertFalse(os.path.exists(os.path.join(tag_dir, "auto.md")))
        tag_text = "\n".join(
            self.m.read(os.path.join(tag_dir, name)) for name in tag_files
        )
        # A workspace-specific tag lives with the workspace that owns it, not in
        # the shared tag directory, so the catalogue can publish one without
        # publishing the other.
        contrib_text = self.m.read(
            self.m.contributor("synasapmob", "libraries", "harness", "dopa-tps.md")
        )
        support_files = (
            ("github", "gh-cli.md"),
            ("github", "clickable-references.md"),
            ("github", "report-summary.md"),
            ("evidence", "approach-history.md"),
            ("evidence", "test-evidence.md"),
            ("evidence", "report-summary.md"),
        )
        # These moved into the workspace that owns them; the harness still has
        # to resolve them, so the suite reads them from their new home.
        contrib_support = (
            ("linear", "creation-policy.md"),
            ("linear", "delivery-readiness.md"),
            ("linear", "requirements-freshness.md"),
            ("linear", "freshness-report-summary.md"),
            ("linear", "report-summary.md"),
            ("playwright", "report-summary.md"),
            ("projects", "routing.md"),
            ("projects", "registry.yaml"),
        )
        support_text = "\n".join(
            self.m.read(self.m.library("harness", *parts))
            for parts in support_files
        )
        support_text += "\n" + "\n".join(
            self.m.read(
                self.m.contributor("synasapmob", "libraries", "harness", *parts)
            )
            for parts in contrib_support
        )
        support_text += "\n" + self.m.read(
            self.m.contributor("synasapmob", "libraries", "hooks", "supabase-routing.md"
            )
        )
        text = (
            root_text + "\n" + tag_text + "\n" + contrib_text + "\n" + support_text
        )
        for tag in ("[answer]", "[answer-step-by-step]", "[answer-priority]",
                    "[report-today]", "[report-yesterday]",
                    "[plan]", "[delivery-local]", "[delivery-ete]",
                    "[delivery-linear-DOPAN-1645]",
                    "[delivery-verify-linear-DOPAN-1722]", "[worktree]", "[ignore]",
                    "[linear]", "[playwright]", "[linear-DOPAN-1645]",
                    "[rebase]", "[draft]", "[mergeable]",
                    "[merge]", "[dopa-tps]"):
            self.assertIn(tag, text)
        self.assertIn("## Tag dispatcher", root_text)
        self.assertIn("read every resolved file", root_text)
        self.assertIn("missing or unreadable", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/dopa-tps.md`", root_text)
        self.assertIn("`tags/report.md`", root_text)
        self.assertIn("## Supporting contract dispatcher", root_text)
        self.assertIn("`github/gh-cli.md`", root_text)
        self.assertIn("`github/clickable-references.md`", root_text)
        self.assertIn("`github/report-summary.md`", root_text)
        self.assertIn("`evidence/approach-history.md`", root_text)
        self.assertIn("`evidence/test-evidence.md`", root_text)
        self.assertIn("`evidence/report-summary.md`", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/linear/creation-policy.md`", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/linear/delivery-readiness.md`", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/linear/requirements-freshness.md`", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/linear/freshness-report-summary.md`", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/linear/report-summary.md`", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/playwright/report-summary.md`", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/projects/routing.md`", root_text)
        self.assertIn("`../../contributors/synasapmob/contributors/default/libraries/harness/projects/registry.yaml`", root_text)
        self.assertIn("contributors/synasapmob/libraries/hooks/supabase-routing.md", root_text)
        self.assertNotIn("## `[delivery-local]`", root_text)
        self.assertNotIn("## `[answer]`", root_text)
        self.assertNotIn("## GitHub and PR contract", root_text)
        self.assertNotIn("## Test evidence ledger", root_text)
        self.assertNotIn("## Supabase routing", root_text)
        self.assertIn("# Delivery tags", self.m.read(
            os.path.join(tag_dir, "delivery.md")
        ))
        self.assertIn("# Answer tags", self.m.read(
            os.path.join(tag_dir, "answer.md")
        ))
        self.assertIn("former split delivery syntax", text)
        self.assertIn("is not an alias", text)
        self.assertIn("By default work in the current", text)
        self.assertIn("checkout; do not create a worktree", text)
        self.assertIn("[worktree] [delivery-local]", text)
        self.assertIn("[delivery-local] [worktree]", text)
        self.assertIn("`Chuẩn bị:`", text)
        self.assertIn("`Bước 1 - Khởi tạo:`", text)
        self.assertIn("`Bước 2 - Xử lý cốt lõi:`", text)
        self.assertIn("`Ưu tiên 1 (Critical)`", text)
        self.assertIn("`Ưu tiên 2 (High)`", text)
        self.assertIn("All answer modes suppress execution handoffs", text)
        self.assertIn("`## Delivery summary` block", text)
        self.assertIn("answer mode is exempt", root_text)
        self.assertIn("# Work report tags", text)
        self.assertIn("calendar-day windows, not a rolling", text)
        self.assertIn("local `00:00:00` at the start of today", text)
        self.assertIn("local `00:00:00` at the start of yesterday", text)
        self.assertIn("completion event falls in the", text)
        self.assertIn("issue `updatedAt` alone is activity", text)
        self.assertIn("one delivered outcome is not counted", text)
        self.assertIn("exact same-file", text)
        self.assertIn("No verified overlap found", text)
        self.assertIn("suggest a Linear task without", text)
        self.assertIn("`SUGGESTED FOLLOW-UPS`", text)
        self.assertIn("`SOURCE COVERAGE`", text)
        self.assertIn("never append `## delivery summary`", text.lower())
        self.assertIn("must update that issue instead of creating a new one", text)
        self.assertIn("# Linear issue creation policy", text)
        self.assertIn("New Linear issue creation is default-deny", text)
        self.assertIn("exact issue-creation budget", text)
        self.assertIn("It authorizes zero auxiliary issues", text)
        self.assertIn("Singular wording means one", text)
        self.assertIn("Every other request has a creation budget of zero", text)
        self.assertIn("No automatic decomposition", text)
        self.assertIn("Suggestion is not authorization", text)
        self.assertIn("does not automatically block the current task", text)
        self.assertIn("Optional hardening, cleanup, refactoring", text)
        self.assertIn("count above the resolved budget", text)
        self.assertIn("`not created`", text)
        self.assertIn("not unlimited permission", text)
        self.assertIn("exactly one owning Linear issue", text)
        self.assertIn("# Existing Linear delivery readiness", text)
        self.assertIn("never authorizes creation of another issue", text)
        self.assertIn("authenticated MCP account/viewer", text)
        self.assertIn("# Verified existing-issue delivery tag", text)
        self.assertIn("# Project routing preflight", text)
        self.assertIn("Normalize HTTPS and SSH forms", text)
        self.assertIn("A directory name is only diagnostic", text)
        self.assertIn("status: unconfigured", text)
        self.assertIn("workspace URL alone never authorizes a team", text)
        self.assertIn("`defaultBranchRef`", text)
        self.assertIn("Never write a\n`default_branch` field", text)
        self.assertIn("# Existing Linear requirements freshness gate", text)
        self.assertIn("ADRs, PRDs, specifications", text)
        self.assertIn("run a fresh remote fetch with pruning", text)
        self.assertIn("`origin/dev` after that fetch", text)
        self.assertIn("a stale remote-tracking", text)
        self.assertIn("final matrix recheck, fetch and prune again", text)
        self.assertIn("If its SHA advanced", text)
        self.assertIn("timestamps", text)
        self.assertIn("ALREADY-IMPLEMENTED", text)
        self.assertIn("BLOCKED-CONFLICT", text)
        self.assertIn("do not create", text)
        self.assertIn("/freshness.md", text)
        self.assertIn("`FRESHNESS:`", text)
        for retired in (
            "[delivery-local-auto]", "[delivery-ete-auto]",
            "[delivery-auto-linear-DOPAN-1645]",
        ):
            self.assertNotIn(retired, text)
        self.assertIn("similar display name alone is not sufficient", text)
        self.assertIn("preserve it even when it is another person", text)
        self.assertIn("estimation configuration through Linear MCP", text)
        self.assertIn("remaining delivery scope, complexity", text)
        self.assertIn("Do not inflate points", text)
        self.assertIn("When an estimate already exists, preserve it", text)
        self.assertIn("required metadata gates", text)
        self.assertIn("Never guess a member", text)
        self.assertIn("`assigned to operator`", text)
        self.assertIn("read and preserved", text)
        self.assertIn("The selector alone does not authorize a Linear write", text)
        self.assertIn("accept only one selector per request", text)
        self.assertIn("belongs to another repository", text)
        self.assertIn("its `gitBranchName` as the canonical Git branch", text)
        self.assertIn("Do not prepend the Git username", text)
        self.assertIn("directory slug is not the Git branch name", text)
        self.assertIn("`gh pr update-branch` equivalent", text)
        self.assertIn("require GitHub to report `MERGED`", text)
        self.assertIn("Do not merely enable auto-merge", text)
        self.assertIn("claim the `[merge]` contract completed", text)
        self.assertIn("gh pr create --help", text)
        self.assertIn("gh pr ready --undo", text)
        self.assertIn("require `isDraft: true`", text)
        self.assertIn(
            "Draft PR cannot satisfy either ready-to-merge contract", text
        )
        self.assertIn("explicitly list every project-level rule", text)
        self.assertIn("`[delivery-ete] [ignore]`", text)
        self.assertIn("still creates its Linear issue and PR", text)
        self.assertIn("actual `baseRefName` is authoritative", text)
        self.assertIn("branch-only range", text)
        self.assertIn("git rev-list --count <remote-base>..HEAD", text)
        self.assertIn("only with `--force-with-lease`", text)
        self.assertIn("`[rebase]` is opt-in", text)
        self.assertIn("dopamint-arena-only runtime modifier", text)
        self.assertIn("./scripts/init-worktree-dev.sh", text)
        self.assertIn("./infra/local-llm/stack start", text)
        self.assertIn("./infra/local-llm/stack status", text)
        self.assertIn("milliontps-network.sh --network localnet --check", text)
        self.assertIn("stack reclaim --dry-run", text)
        self.assertIn("`clear --all` can wipe every dopamint-arena", text)
        self.assertIn("stack is deliberately persistent", text)
        self.assertIn("Keep working until exactly one GitHub PR", text)
        self.assertIn("Mergeability resolution", text)
        self.assertIn("evidence-backed ownership classification", text)
        self.assertIn("already failing on the base branch", text)
        self.assertIn("never rerun repeatedly to fish for green", text)
        self.assertIn("full `[mergeable]` diagnosis", text)
        self.assertIn("`Mergeability blocker`", text)
        self.assertIn("Do not leave a discovered blocker silent", text)
        self.assertIn("every affected file or subsystem", text)
        self.assertIn("collateral-impact assessment", text)
        self.assertIn("before-versus-after behavior", text)
        self.assertIn("every failure therefore receives", text.lower())
        self.assertIn("human approval and missing external authority", text)
        self.assertIn("# Clickable work references", text)
        self.assertIn("[DOPAN-1625 · REVIEW](<verified-linear-url>)", text)
        self.assertIn("identifier to `DOPAN-1625`", text)
        self.assertIn("[PR #1336 · REVIEW](<verified-github-pr-url>)", text)
        self.assertIn(
            "[COMMIT-REVIEW-6aaab0e](<verified-github-commit-url>)",
            text,
        )
        self.assertIn(
            "[COMMIT-MERGED-6aaab0e](<verified-github-commit-url>)",
            text,
        )
        self.assertIn("COMMIT-DRAFT-<short-sha>", text)
        self.assertIn("COMMIT-IN-PROGRESS-<short-sha>", text)
        self.assertIn("COMMIT-LOCAL-6aaab0e", text)
        self.assertIn("unique short SHA of at least", text)
        self.assertIn("reachable from a verified remote", text)
        self.assertIn("`COMMIT-LOCAL-<short-sha>` label", text)
        self.assertIn("no GitHub URL exists", text)
        self.assertIn("`#478be6`", text)
        self.assertIn("`#8256d0`", text)
        self.assertIn("`#656c76`", text)
        self.assertIn("cannot force link text color", text)
        self.assertIn("Do not emit inline HTML/CSS", text)
        self.assertIn("Never label a commit `MERGED`", text)
        self.assertIn("use the issue's returned URL", text)
        self.assertIn("through `gh`", text)
        self.assertIn("do not invent a link", text)
        self.assertIn("# Mandatory reference audit", text)
        self.assertIn("all-output requirement", text)
        self.assertIn("Never require the operator to type the", text)
        self.assertIn("`DOPAN-` prefix first", text)
        self.assertIn("461b8e91c", text)
        self.assertIn("entire composed output", text)
        self.assertIn("one link must never cover multiple identifiers", text)
        self.assertIn("Do not send while any known reference", text)
        self.assertIn("reference came from the operator", text)
        self.assertIn("failed lookup never permits falling back", text)
        self.assertIn("## Frontend convention gate", text)
        self.assertIn("without a workflow tag", text)
        self.assertIn("audit every changed frontend", text)
        self.assertIn("never silently skip the convention check", text)
        self.assertIn("Keep convention bodies modular by domain", text)
        self.assertIn("own `<domain>-convention` skill directory", text)
        self.assertIn("/Users/synasapmob/orca/workspaces/<project>", text)
        self.assertIn(
            "/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/"
            "FE/screenshots/",
            text,
        )
        self.assertIn("use the normalized uppercase issue ID alone", text)
        self.assertIn("Never append the issue title", text)
        self.assertNotIn("<task-slug>-<timestamp>", text)
        self.assertIn("always close the Playwright page", text)
        self.assertIn("created by this task", text)
        self.assertIn("Never use `pkill`, `killall`", text)
        self.assertIn("whose ownership is uncertain", text)
        self.assertIn("Browser cleanup never deletes screenshot evidence", text)
        self.assertIn(
            "/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/",
            text,
        )
        self.assertIn("`FE/evidence/`", text)
        self.assertIn("`BE/evidence/`", text)
        self.assertIn("`001-fail.log`", text)
        self.assertIn("`002-pass.log`", text)
        self.assertIn("Do not create an extra `runs/` directory", text)
        self.assertNotIn("/Users/synasapmob/orca/screenshot/", text)
        self.assertNotIn("/Users/synasapmob/orca/evidence/", text)
        self.assertNotIn("`runs/001-*.log`", text)
        self.assertIn("Never erase or overwrite a failed run", text)
        self.assertIn("candidate run under the same command", text)
        self.assertIn("Capture complete stdout/stderr", text)
        self.assertIn("## Compact handoff", text)
        self.assertIn("links the absolute `manifest.md` path", text)
        self.assertIn("at most one brief overall summary", text)
        self.assertIn("Do not repeat commands, long logs", text)
        self.assertIn("# GitHub report summary", text)
        self.assertIn("# Linear report summary", text)
        self.assertIn("# Evidence report summary", text)
        self.assertIn("# Playwright report summary", text)
        self.assertIn("`## Delivery summary`", text)
        self.assertIn("start with `Touched:`", text)
        self.assertIn("`LINEAR:`", text)
        self.assertIn("`GITHUB:`", text)
        self.assertIn("`EVIDENCE:`", text)
        self.assertIn("`PLAYWRIGHT:`", text)
        self.assertIn("Omit", text)
        self.assertIn("domains; report `FAIL`", text)
        self.assertIn("every issue created or updated", text)
        self.assertIn("fail-to-fix-to-pass history", text)
        self.assertIn("failed update to make the summary look complete", text)
        self.assertIn("verified lifecycle-bearing clickable label", text)
        self.assertIn("one bullet per independent fact group", root_text)
        self.assertIn("one top-level Markdown list item per PR", text)
        self.assertIn("one top-level Markdown list item per Linear issue", text)
        self.assertIn("separate top-level Markdown list items", text)
        self.assertIn("`Result` — final status", text)
        self.assertIn("`Flow` — the meaningful user actions", text)
        self.assertIn("`Screenshots` — verified count", text)
        self.assertIn("`Defects` — observed", text)
        self.assertIn("`Cleanup` — scoped", text)
        self.assertIn("- **Result:** PASS/FAIL/BLOCKED/INCOMPLETE", text)
        self.assertIn("- **Flow:** Actions exercised", text)
        self.assertIn("- **Screenshots:** Count and folder link", text)
        self.assertIn("- **Defects:** Observed", text)
        self.assertIn("- **Cleanup:** Scoped close result", text)
        self.assertIn(
            "Never combine result, flow, screenshots, defects and browser",
            text,
        )
        self.assertIn("# Approach history", text)
        self.assertIn(
            "/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/"
            "approach.md",
            text,
        )
        self.assertIn("shared across frontend, backend and integration", text)
        self.assertIn("## Append-only date grouping", text)
        self.assertIn("### 13:30 ICT — Wallet connection", text)
        self.assertIn("Do not append an entry for each command", text)
        self.assertIn("Ordinarily one completed task needs one entry", text)
        self.assertIn("Scope: FE`, `Scope: BE`", text)
        self.assertIn("Never dump raw hidden reasoning", text)
        self.assertIn("re-read the current file", text)
        self.assertIn(
            "/Users/synasapmob/.hub-william/contributors/default/libraries/templates/"
            "test-evidence.md",
            text,
        )
        self.assertIn(
            "/Users/synasapmob/.hub-william/contributors/default/libraries/templates/"
            "approach-history.md",
            text,
        )
        self.assertIn(
            "/Users/synasapmob/.hub-william/contributors/"
            "synasapmob/contributors/default/libraries/templates/linear-issue.md",
            text,
        )
        self.assertIn(
            "/Users/synasapmob/.hub-william/contributors/"
            "synasapmob/contributors/default/libraries/templates/github-pull-request.md",
            text,
        )
        self.assertNotIn(
            "/Users/synasapmob/Documents/commandoss/dopamint-arena/"
            ".github/pull_request_template.md",
            text,
        )

    def test_test_evidence_template_preserves_failure_history_and_comparisons(self):
        template = self.m.read(
            self.m.library("templates", "test-evidence.md")
        )
        self.assertIn("# Test evidence", template)
        self.assertIn("## Run history", template)
        self.assertIn("Failed", template)
        self.assertIn("Root cause and fix", template)
        self.assertIn("Baseline", template)
        self.assertIn("Candidate", template)
        self.assertIn("Remaining gaps", template)

    def test_approach_history_template_is_append_only_and_cross_surface(self):
        template = self.m.read(
            self.m.library("templates", "approach-history.md")
        )
        self.assertIn("# Approach history", template)
        self.assertIn("Never edit, reorder or delete", template)
        self.assertIn("## YYYY-MM-DD", template)
        self.assertIn("### HH:MM TZ — Short title", template)
        self.assertIn("Scope: FE | BE | Integration", template)
        self.assertIn("Behavior before", template)
        self.assertIn("Behavior after", template)
        self.assertIn("FE ↔ BE flow", template)

    def test_requirements_freshness_template_is_append_only_and_traceable(self):
        template = self.m.read(
            self.m.library("templates", "requirements-freshness.md")
        )
        self.assertIn("# Requirements freshness history", template)
        self.assertIn("Never edit, reorder or delete", template)
        self.assertIn("Repository / base", template)
        self.assertIn("Source inventory", template)
        self.assertIn("Authority rationale", template)
        self.assertIn("Requirement / AC", template)
        self.assertIn("BLOCKED-CONFLICT", template)

    def test_project_registry_uses_direct_destinations_without_cached_branch(self):
        registry = self.m.read(
            self.m.contributor("synasapmob", "libraries", "harness", "projects", "registry.yaml"
            )
        )
        self.assertIn("CommandOSSLabs/dopamint-arena:", registry)
        self.assertIn(
            "github_url: https://github.com/CommandOSSLabs/dopamint-arena",
            registry,
        )
        self.assertIn("workspace_url: https://linear.app/commandoss", registry)
        self.assertIn("team_key: DOPAN", registry)
        self.assertIn("Southern-Discoveries/hub-william:", registry)
        self.assertIn("status: disabled", registry)
        self.assertIn("Southern-Discoveries/sonix-study:", registry)
        self.assertIn("status: unconfigured", registry)
        self.assertNotIn("default_branch:", registry)

    def test_quick_guide_uses_canonical_delivery_and_answer_tags(self):
        guide = self.m.read(
            os.path.join(self.m.machine, "harness_guiline.md")
        )
        for tag in ("[delivery-ete]", "[delivery-local]",
                    "[delivery-linear-DOPAN-1645]",
                    "[delivery-verify-linear-DOPAN-1722]",
                    "[answer-step-by-step]", "[answer-priority]",
                    "[report-today]", "[report-yesterday]"):
            self.assertIn(tag, guide)
        self.assertNotRegex(
            guide, r"(?m)^- `\[delivery\] \[(ete|local|linear-)"
        )
        self.assertIn("[worktree] [delivery-local]", guide)
        self.assertIn("exactly four canonical modes", guide)
        self.assertIn("tags containing an `auto` segment are unsupported", guide)
        self.assertIn("`Mergeability blocker` PR comment", guide)
        self.assertIn("Never fail silently", guide)
        self.assertIn("root cause/fix → pass", guide)
        self.assertIn("No answer mode emits a", guide)
        self.assertIn("`Delivery summary`, `Touched:`", guide)
        self.assertIn("## Work report", guide)
        self.assertIn("not a rolling 24-hour window", guide)
        self.assertIn("`TEAM OVERLAP`", guide)
        self.assertIn("`REMAINING / GAPS`", guide)
        self.assertIn("suggests follow-up Linear tasks only", guide)
        self.assertIn("Both tags are report-only", guide)
        self.assertIn("## Clickable references", guide)
        self.assertIn("## Tag modules", guide)
        self.assertIn("contributors/default/libraries/harness/tags/", guide)
        self.assertIn("## Supporting modules", guide)
        self.assertIn("harness/github/gh-cli.md", guide)
        self.assertIn("harness/github/clickable-references.md", guide)
        self.assertIn("harness/github/report-summary.md", guide)
        self.assertIn("contributors/synasapmob/contributors/default/libraries/harness/linear/creation-policy.md", guide)
        self.assertIn("contributors/synasapmob/contributors/default/libraries/harness/linear/delivery-readiness.md", guide)
        self.assertIn("contributors/synasapmob/contributors/default/libraries/harness/linear/requirements-freshness.md", guide)
        self.assertIn("contributors/synasapmob/contributors/default/libraries/harness/linear/freshness-report-summary.md", guide)
        self.assertIn("contributors/synasapmob/contributors/default/libraries/harness/linear/report-summary.md", guide)
        self.assertIn("harness/evidence/test-evidence.md", guide)
        self.assertIn("harness/evidence/approach-history.md", guide)
        self.assertIn("harness/evidence/report-summary.md", guide)
        self.assertIn("contributors/synasapmob/contributors/default/libraries/harness/playwright/report-summary.md", guide)
        self.assertIn("contributors/synasapmob/contributors/default/libraries/harness/projects/routing.md", guide)
        self.assertIn("contributors/synasapmob/contributors/default/libraries/harness/projects/registry.yaml", guide)
        self.assertIn("contributors/synasapmob/libraries/hooks/supabase-routing.md", guide)
        self.assertIn("finish with one `## Delivery summary`", guide)
        self.assertIn("Start with `Touched:`", guide)
        self.assertIn("`LINEAR:`", guide)
        self.assertIn("`GITHUB:`", guide)
        self.assertIn("`EVIDENCE:`", guide)
        self.assertIn("`PLAYWRIGHT:`", guide)
        self.assertIn("one bullet per", guide)
        self.assertIn("`Result`, `Flow`, `Screenshots`, `Defects`", guide)
        self.assertIn("one top-level item per", guide)
        self.assertIn("Linear issue creation is default-deny", guide)
        self.assertIn("may create exactly one", guide)
        self.assertIn("existing-issue delivery creates zero new issues", guide)
        self.assertIn("`not created` suggestion", guide)
        self.assertIn("never mark the current task", guide.lower())
        self.assertIn("If unassigned, resolve the operator's", guide)
        self.assertIn("If estimate", guide)
        self.assertIn("team's configured point scale", guide)
        self.assertIn("Preserve populated assignee", guide)
        self.assertIn("explicit completion blocker", guide)
        self.assertIn("## Project routing", guide)
        self.assertIn("Directory names and conversation context never select", guide)
        self.assertIn("https://linear.app/commandoss", guide)
        self.assertIn("Linear disabled", guide)
        self.assertIn("Linear unconfigured", guide)
        self.assertIn("current `defaultBranchRef`", guide)
        self.assertIn("Verified ETE from an existing Linear issue", guide)
        self.assertIn("every requirement/AC", guide)
        self.assertIn("freshness.md", guide)
        self.assertIn("without duplicate code or an empty PR", guide)
        self.assertIn("`origin/dev` (remote default", guide)
        self.assertIn("Fetch again before final handoff", guide)
        self.assertIn(
            "/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/"
            "FE/screenshots/",
            guide,
        )
        self.assertIn(
            "/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/"
            "FE/evidence/",
            guide,
        )
        self.assertIn(
            "/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/"
            "BE/evidence/",
            guide,
        )
        self.assertIn("do not create another `runs/`", guide)
        self.assertIn("## Approach history", guide)
        self.assertIn("one `## YYYY-MM-DD` per local date", guide)
        self.assertIn("`### 13:30 ICT — Wallet connection`", guide)
        self.assertIn("Do not split it into FE/BE files", guide)
        self.assertIn("Usually write one entry", guide)
        self.assertIn("Scope: FE | BE | Integration", guide)
        self.assertIn("show its latest `PASS`/`FAIL`/`BLOCKED`", guide)
        self.assertIn("Review — `#478be6`", guide)
        self.assertIn("Merged or verified Done — `#8256d0`", guide)
        self.assertIn("Draft, Local or In progress — `#656c76`", guide)
        self.assertIn("named props interfaces, forms/validation", guide)
        self.assertIn("## Convention modules", guide)
        self.assertIn("contributors/default/libraries/skills/backend-convention/", guide)
        self.assertIn(
            "[DOPAN-1625 · REVIEW](verified Linear URL)", guide
        )
        self.assertIn("[PR #1336 · REVIEW](verified GitHub URL)", guide)
        self.assertIn(
            "[COMMIT-REVIEW-6aaab0e](verified full-SHA URL)", guide
        )
        self.assertIn(
            "[COMMIT-MERGED-6aaab0e](verified full-SHA URL)", guide
        )
        self.assertIn("COMMIT-LOCAL-6aaab0e", guide)
        self.assertIn("scan the complete", guide)
        self.assertIn("expand groups so every identifier gets", guide)
        self.assertIn("never knowingly send a bare task number", guide)
        self.assertIn("recent conversation", guide)
        self.assertIn("normalized `UNVERIFIED` label", guide)

    def test_frontend_convention_is_an_installable_catalog_skill(self):
        skill = self.m.library("skills", "frontend-convention", "SKILL.md")
        self.assertIn("name: frontend-convention", self.m.read(skill))
        reference = self.m.library("skills", "frontend-convention", "references",
            "frontend-conventions.md",
        )
        reference_text = self.m.read(reference)
        expected_headings = ("## Declare props as a named interface",
                             "## Forms and validation",
                             "## Tailwind and class composition",
                             "## Reuse inside a component",
                             "## Layout and semantics")
        for heading in expected_headings:
            self.assertIn(heading, reference_text)
        heading_positions = [reference_text.index(heading)
                             for heading in expected_headings]
        self.assertEqual(heading_positions, sorted(heading_positions))
        skill_text = self.m.read(skill)
        self.assertIn("Read [references/frontend-conventions.md]", skill_text)
        self.assertIn("completely before editing", skill_text)
        self.assertIn("Explicitly check all five", skill_text)
        forbidden_provenance = (
            "Source " + "reference",
            "/Documents/personal/" + "sonix-study/",
        )
        for forbidden in forbidden_provenance:
            self.assertNotIn(forbidden, reference_text)

        self.init()

        for agent in ("claude", "codex", "grok"):
            installed = self.m.skill_link(agent, "frontend-convention")
            self.assertTrue(os.path.isdir(installed))
            self.assertFalse(os.path.islink(installed))
            self.assertTrue(os.path.isfile(os.path.join(
                installed, ".hub-william-generated.json"
            )))

    def test_delivery_templates_are_local_catalog_sources(self):
        pr = self.m.read(
            self.m.contributor("synasapmob", "libraries", "templates", "github-pull-request.md"
            )
        )
        linear = self.m.read(
            self.m.contributor("synasapmob", "libraries", "templates", "linear-issue.md"
            )
        )
        for heading in ("## Context", "## What's included",
                        "## Design and implementation",
                        "## Risks, concerns, and gaps", "## Testing"):
            self.assertIn(heading, pr)
        for heading in ("## Context", "## Goal", "## Scope",
                        "## Out of scope", "## Acceptance criteria",
                        "## Delivery state", "## Verification",
                        "## Dependencies", "## Ownership and review",
                        "## References"):
            self.assertIn(heading, linear)
        self.assertIn("DOPAN-175 supplied the structure only", linear)

    def test_project_harness_files_are_outside_the_reconciler_scope(self):
        project_harness = self.m.write(
            self.m.machine_path("some-project", "AGENTS.md"),
            "# project-specific Linear rules\n",
        )

        self.init()

        self.assertEqual(
            self.m.read(project_harness), "# project-specific Linear rules\n"
        )

    def test_your_own_zsh_directory_is_kept_and_linked_into(self):
        """~/.zsh is a real directory holding one link per fragment, so an
        existing one needs no backup: our links go in beside your files."""
        self.m.write(self.m.home_path(".zsh", "mine.zsh"), "# keep me\n")
        self.init()

        home_zsh = self.m.home_path(".zsh")
        self.assertTrue(os.path.isdir(home_zsh))
        self.assertFalse(os.path.islink(home_zsh))
        self.assertEqual(self.m.read(os.path.join(home_zsh, "mine.zsh")), "# keep me\n")
        self.assertTrue(os.path.islink(os.path.join(home_zsh, "terminal.zsh")))
        self.assertEqual(
            [name for name in os.listdir(self.m.home)
             if name.startswith(".zsh.before-hub-william")],
            [],
        )

    def test_a_fragment_of_yours_with_our_name_is_reported_not_replaced(self):
        self.m.write(self.m.home_path(".zsh", "terminal.zsh"), "# mine\n")
        result = self.init()
        self.assertIn("a real file is there", result.out)
        self.assertEqual(
            self.m.read(self.m.home_path(".zsh", "terminal.zsh")), "# mine\n"
        )

    def test_an_unticked_fragment_is_never_linked(self):
        """grok.zsh ships ticked; take it out of the profile and only it goes."""
        self.init()
        for name in ("grok.zsh", "terminal.zsh"):
            self.assertTrue(os.path.islink(self.m.home_path(".zsh", name)), name)

        profile = self.m.machine_path("profiles", "local.toml")
        self.m.write(profile, self.m.read(profile).replace('"grok.zsh", ', ""))
        result = self.m.run("sync", "--yes")
        self.assertEqual(result.code, 0, result)

        self.assertFalse(os.path.lexists(self.m.home_path(".zsh", "grok.zsh")))
        self.assertTrue(os.path.islink(self.m.home_path(".zsh", "terminal.zsh")))

    def test_a_whole_directory_link_is_converted_to_one_link_per_fragment(self):
        """What the previous version installed. Converting is what makes a
        single fragment declinable at all — and it must carry the one file in
        there nobody can re-create."""
        legacy = self.m.write(self.m.catalog("zsh", "secrets.zsh"),
                              'export HUB_WILLIAM_KEY="mine"\n')
        home_zsh = self.m.home_path(".zsh")
        os.symlink(self.m.catalog("zsh"), home_zsh)
        result = self.init()
        self.assertEqual(result.code, 0, result)

        self.assertIn("was a link to the whole catalog", result.out)
        self.assertFalse(os.path.islink(home_zsh))
        self.assertTrue(os.path.isdir(home_zsh))
        self.assertEqual(
            os.path.realpath(os.path.join(home_zsh, "terminal.zsh")),
            os.path.realpath(self.m.catalog("zsh", "terminal.zsh")),
        )
        self.assertEqual(self.m.read(os.path.join(home_zsh, "secrets.zsh")),
                         'export HUB_WILLIAM_KEY="mine"\n')
        self.assertFalse(os.path.exists(legacy))

    def test_secrets_are_created_once_in_home_and_never_overwritten(self):
        self.init()
        secrets = self.m.home_path(".zsh", "secrets.zsh")
        self.assertTrue(os.path.isfile(secrets))
        self.assertFalse(os.path.islink(secrets))
        self.assertIn("HUB_WILLIAM_KEY", self.m.read(secrets))

        self.m.write(secrets, 'export HUB_WILLIAM_KEY="real"\n')
        self.m.run("sync", "--yes")
        self.assertEqual(self.m.read(secrets), 'export HUB_WILLIAM_KEY="real"\n')

    def test_secrets_left_in_the_catalog_are_moved_out_of_the_repo(self):
        """Where they used to live, back when ~/.zsh was one symlink."""
        legacy = self.m.catalog("zsh", "secrets.zsh")
        self.m.write(legacy, 'export HUB_WILLIAM_KEY="mine"\n')
        self.init()

        self.assertFalse(os.path.exists(legacy))
        self.assertEqual(self.m.read(self.m.home_path(".zsh", "secrets.zsh")),
                         'export HUB_WILLIAM_KEY="mine"\n')

    def test_secrets_no_longer_carries_a_supabase_token(self):
        """Supabase moved to per-project MCP servers, so the example must not
        keep offering a place to paste a PAT — an unused credential in a
        plaintext file is the thing that swap was meant to remove."""
        self.init()
        example = self.m.read(self.m.catalog("zsh", "secrets.zsh.example"))
        self.assertNotIn("SUPABASE_TOKEN", example)
        self.assertIn("HUB_WILLIAM_KEY", example)

    def test_dopa_tps_is_executed_as_bash_and_guards_its_project(self):
        """The fragment is zsh, the work is bash. Sourcing the script into zsh
        instead would not error — word splitting, arrays and `compgen` would
        just quietly mean something else, in a script that kills processes and
        wipes docker volumes."""
        zsh = shutil.which("zsh")
        if not zsh:
            self.skipTest("no zsh here")
        self.init()

        link = self.m.home_path(".zsh", "dopa-tps.zsh")
        self.assertTrue(os.path.islink(link), link)
        self.assertIn('bash "$_dopa_tps_script"', self.m.read(link))
        # the 400-line script rides along but is never linked or sourced
        self.assertTrue(os.path.isfile(self.m.catalog("zsh", "dopa-tps.bash")))
        self.assertFalse(os.path.lexists(self.m.home_path(".zsh", "dopa-tps.bash")))

        completed = subprocess.run(
            [zsh, "-c", 'source "%s"; cd "%s"; dopa-tps reset' % (link, self.m.root)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            universal_newlines=True,
        )
        self.assertEqual(completed.returncode, 1, completed.stdout)
        self.assertIn("dopamint-arena worktree", completed.stdout)

    def test_the_example_names_no_key_for_an_oauth_server(self):
        """Linear, Notion and Slack log in through a browser. A key named for
        one of them in here is something to go looking for that is not there."""
        text = self.m.read(self.m.catalog("zsh", "secrets.zsh.example"))
        exported = re.findall(r"^export (\w+)", text, re.M)
        for name in exported:
            for oauth in ("LINEAR", "NOTION", "SLACK"):
                self.assertNotIn(oauth, name, name)

    def test_example_secrets_hold_no_values(self):
        text = self.m.read(self.m.catalog("zsh", "secrets.zsh.example"))
        for line in text.splitlines():
            if line.startswith("export "):
                self.assertTrue(line.endswith('=""'), line)

    def test_catalog_fragments_hold_no_tokens(self):
        """A token is a *value*. `hw_sk_...` inside a comment is documentation."""
        leak = re.compile(r"""=\s*["']?(hw_sk_|sbp_)[A-Za-z0-9_-]{8,}""")
        for name in os.listdir(self.m.catalog("zsh")):
            text = self.m.read(self.m.catalog("zsh", name)) or ""
            self.assertIsNone(leak.search(text), "%s leaks a token" % name)
            self.assertNotIn("Bearer hw_sk_", text, "%s leaks a header" % name)

    def test_zshrc_gets_one_managed_block_and_loses_the_scratchpad_line(self):
        self.m.write(self.m.home_path(".zshrc"), "\n".join([
            'export PATH="$HOME/.cargo/bin:$PATH"',
            "source ~/.zsh/grok.zsh",
            'source ~/.zsh/terminal.zsh',
            '. "/private/tmp/claude-501/-Users-me/abc/scratchpad/deno/env"',
            "",
        ]))
        self.init()
        text = self.m.read(self.m.home_path(".zshrc"))
        self.assertEqual(text.count(">>> hub william machine >>>"), 1)
        self.assertNotIn("scratchpad/deno/env", text)
        self.assertIn('export PATH="$HOME/.cargo/bin:$PATH"', text)
        self.assertIn("# source ~/.zsh/grok.zsh", text)

        self.m.run("sync")
        self.assertEqual(
            self.m.read(self.m.home_path(".zshrc")).count(">>> hub william machine >>>"), 1
        )

    def test_zshrc_is_backed_up_before_the_first_edit(self):
        self.m.write(self.m.home_path(".zshrc"), "# mine\n")
        self.init()
        backups = [n for n in os.listdir(self.m.home)
                   if n.startswith(".zshrc.before-hub-william")]
        self.assertEqual(len(backups), 1, backups)
        self.assertEqual(self.m.read(self.m.home_path(backups[0])), "# mine\n")

    def test_a_zshrc_symlinked_into_dotfiles_is_written_through(self):
        real = self.m.write(os.path.join(self.m.root, "dotfiles", "zshrc"), "# mine\n")
        os.symlink(real, self.m.home_path(".zshrc"))
        self.init()
        self.assertTrue(os.path.islink(self.m.home_path(".zshrc")))
        self.assertEqual(os.path.realpath(self.m.home_path(".zshrc")),
                         os.path.realpath(real))
        self.assertIn(">>> hub william machine >>>", self.m.read(real))
        self.assertIn("# mine", self.m.read(real))

    def test_turning_zsh_off_reverses_the_zshrc_edits(self):
        self.m.write(self.m.home_path(".zshrc"), "\n".join([
            'export PATH="$HOME/.cargo/bin:$PATH"',
            "source ~/.zsh/grok.zsh",
            "",
        ]))
        self.init()
        profile = self.m.machine_path("profiles", "local.toml")
        self.m.write(profile, re.sub(
            r"shell_allow = \[[^\]]*\]", "shell_allow = []", self.m.read(profile)
        ))

        result = self.m.run("sync", "--yes")
        self.assertEqual(result.code, 0, result)
        text = self.m.read(self.m.home_path(".zshrc"))
        self.assertNotIn("hub william machine", text)
        self.assertIn("source ~/.zsh/grok.zsh", text)
        self.assertNotIn("# source ~/.zsh/grok.zsh", text)
        for name in ("grok.zsh", "dopa-tps.zsh", "terminal.zsh"):
            self.assertFalse(os.path.lexists(self.m.home_path(".zsh", name)), name)
        # secrets.zsh is yours, so ~/.zsh stays behind holding it.
        self.assertEqual(os.listdir(self.m.home_path(".zsh")), ["secrets.zsh"])


class TestGrokCompat(MachineTest):
    def test_compat_is_set_when_grok_and_claude_differ(self):
        self.init()
        config = self.m.read(self.m.home_path(".grok", "config.toml"))
        self.assertNotIn("[compat.claude]", config)

        self.m.run("skill", "remove", "frontend-verify", "--agent", "grok")
        config = self.m.read(self.m.home_path(".grok", "config.toml"))
        self.assertIn("[compat.claude]", config)
        self.assertIn("skills = false", config)

        self.m.run("skill", "add", "frontend-verify", "--agent", "grok")
        config = self.m.read(self.m.home_path(".grok", "config.toml"))
        self.assertNotIn("[compat.claude]", config)


class TestMcpAuth(MachineTest):
    def test_named_missing_agent_is_an_error(self):
        """Plan test 6."""
        self.init()
        self.m.drop_cli("grok")
        result = self.m.run("mcp", "auth", "linear", "--agent", "grok")
        self.assertNotEqual(result.code, 0, result)
        self.assertIn("not on PATH", result.out)

    def test_missing_agent_without_the_flag_is_a_skip(self):
        """Plan test 7."""
        self.init()
        self.m.drop_cli("grok")
        result = self.m.run("mcp", "auth")
        self.assertEqual(result.code, 0, result)
        self.assertIn("grok", result.out)
        self.assertIn("CLI not on PATH", result.out)

    def test_stdio_servers_have_nothing_to_authenticate(self):
        self.init()
        result = self.m.run("mcp", "auth", "playwright")
        self.assertNotEqual(result.code, 0, result)
        self.assertIn("nothing to log in to", result.out)

    def test_auth_lists_the_oauth_pairs_without_logging_anything_in(self):
        self.init()
        result = self.m.run("mcp", "auth", "linear")
        self.assertEqual(result.code, 0, result)
        self.assertIn("linear x claude", result.out)
        self.assertIn("codex mcp login linear", result.out)
        self.assertIn("/mcps", result.out)
        # Asking an agent whether it already has a token is a `mcp list`, and
        # listing is allowed to do that. Opening a browser is `mcp login`, and
        # that is the thing a listing must never reach.
        self.assertEqual(
            [call for call in self.m.cli_calls() if "login" in call], []
        )

    def test_unregistered_server_is_skipped(self):
        result = self.m.run("mcp", "auth", "linear")
        self.assertEqual(result.code, 0, result)
        self.assertIn("not registered yet", result.out)

    def test_an_agent_that_already_has_a_token_is_not_offered_again(self):
        """A list that offers everything is a list nobody reads to the end.

        Neither CLI lets us open its token store, which is why this used to
        offer every pair every time — but both will answer the question we are
        actually asking, so ask them.
        """
        self.init()
        self.m.add_cli("codex", (
            'if [ "$*" = "mcp list --json" ]; then\n'
            '  printf \'[{"name":"linear","auth_status":"o_auth"}]\\n\'\n'
            'fi\n'
        ))
        self.m.add_cli("claude", (
            'if [ "$*" = "mcp list" ]; then\n'
            '  printf "linear: https://mcp.linear.app/mcp (HTTP) - Connected\\n"\n'
            'fi\n'
        ))
        result = self.m.run("mcp", "auth", "linear")
        self.assertEqual(result.code, 0, result)
        self.assertIn("already has a token", result.line_for("linear x codex"))
        self.assertIn("already has a token", result.line_for("linear x claude"))
        self.assertNotIn("still to do: linear x claude", result.out)

    def test_an_agent_that_still_needs_a_token_is_still_offered(self):
        """The other half: a `no` has to stay a `no`, or the quiet list is
        quiet because it stopped looking."""
        self.init()
        self.m.add_cli("claude", (
            'if [ "$*" = "mcp list" ]; then\n'
            '  printf "linear: https://mcp.linear.app/mcp (HTTP) -'
            ' Needs authentication\\n"\n'
            'fi\n'
        ))
        result = self.m.run("mcp", "auth", "linear")
        self.assertEqual(result.code, 0, result)
        self.assertNotIn("already has a token",
                         result.line_for("linear x claude"))

    def test_a_token_under_another_name_does_not_count(self):
        """Grok reads the key for the server it is starting. A token filed
        under a different name for the same URL is not one it will use, and
        calling it one is how `mcp auth` reports success against a grok that
        still says it needs authenticating."""
        self.init()
        self.m.write(
            self.m.home_path(".grok", "mcp_credentials.json"),
            '{"linear-server:https://mcp.linear.app/mcp": {"client_id": "x"}}',
        )
        result = self.m.run("mcp", "auth", "linear", "--agent", "grok")
        self.assertEqual(result.code, 0, result)
        self.assertNotIn("already has a token", result.out)
        self.assertIn("linear x grok", result.out)

    def test_grok_skips_a_server_it_already_has_a_token_for(self):
        self.init()
        self.m.write(
            self.m.home_path(".grok", "mcp_credentials.json"),
            '{"linear:https://mcp.linear.app/mcp": {"client_id": "x"}}',
        )
        result = self.m.run("mcp", "auth", "linear")
        self.assertIn("already has a token", result.out)


class TestDamagedInputs(MachineTest):
    def test_a_lost_state_file_still_lets_a_deny_uninstall(self):
        self.init()
        link = self.m.skill_link("claude", "frontend-verify")
        self.assertTrue(os.path.isdir(link))
        self.assertFalse(os.path.islink(link))
        os.unlink(self.m.machine_path("state", "applied.json"))

        result = self.m.run("skill", "remove", "frontend-verify", "--agent", "claude")
        self.assertEqual(result.code, 0, result)
        self.assertFalse(os.path.lexists(link))

    def test_an_unreadable_state_file_is_reported_and_kept(self):
        self.init()
        self.m.write(self.m.machine_path("state", "applied.json"), "{not json")
        result = self.m.run("sync")
        self.assertEqual(result.code, 0, result)
        self.assertIn("unreadable", result.out)
        backups = [n for n in os.listdir(self.m.machine_path("state"))
                   if n.startswith("applied.json.unreadable")]
        self.assertEqual(len(backups), 1, backups)

    def test_invalid_claude_json_is_reported_not_clobbered(self):
        self.m.write(self.m.home_path(".claude.json"), "{ this is not json")
        result = self.m.run("init", "--yes")
        self.assertEqual(result.code, 0, result)
        self.assertIn("not valid JSON", result.out)
        self.assertEqual(self.m.read(self.m.home_path(".claude.json")),
                         "{ this is not json")
        # The other agents were still configured.
        self.assertIn("linear", self.m.toml_mcp("codex"))

    def test_a_byte_order_mark_does_not_stop_the_merge(self):
        self.m.write(self.m.home_path(".codex", "config.toml"),
                     "﻿model = \"gpt-5.6-sol\"\n")
        self.init()
        text = self.m.read(self.m.home_path(".codex", "config.toml"))
        self.assertTrue(text.startswith("﻿"))
        self.assertIn("linear", self.m.toml_mcp("codex"))

    def test_an_unparsable_agent_config_is_left_alone(self):
        self.m.write(self.m.home_path(".codex", "config.toml"), "this = = broken\n")
        result = self.m.run("init", "--yes")
        self.assertEqual(result.code, 0, result)
        self.assertIn("cannot parse", result.out)
        self.assertEqual(self.m.read(self.m.home_path(".codex", "config.toml")),
                         "this = = broken\n")
        self.assertIn("linear", self.m.claude_mcp())


class TestLocking(MachineTest):
    def test_a_live_lock_blocks_a_second_run(self):
        self.m.write(self.m.machine_path("state", ".lock"), "%d 0\n" % os.getpid())
        result = self.m.run("sync")
        self.assertEqual(result.code, 1, result)
        self.assertIn("another machine install is running", result.out)

    def test_a_stale_lock_is_broken(self):
        self.m.write(self.m.machine_path("state", ".lock"), "999999 0\n")
        result = self.m.run("sync")
        self.assertEqual(result.code, 0, result)

    def test_dry_run_takes_no_lock_and_changes_nothing(self):
        result = self.m.run("sync", "--dry-run")
        self.assertEqual(result.code, 0, result)
        self.assertIn("dry run", result.out)
        self.assertFalse(os.path.exists(self.m.home_path(".claude.json")))
        self.assertIsNone(self.m.applied())


class TestNoAgentsAtAll(MachineTest):
    clis = ("gh",)

    def test_init_without_any_agent_cli_fails_cleanly(self):
        result = self.m.run("init", "--yes")
        self.assertEqual(result.code, 1, result)
        self.assertIn("no agent CLI on PATH", result.out)

    def test_sync_without_any_agent_cli_is_quiet(self):
        result = self.m.run("sync")
        self.assertEqual(result.code, 0, result)


if __name__ == "__main__":
    unittest.main()
