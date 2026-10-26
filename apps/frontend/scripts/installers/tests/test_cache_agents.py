"""Exercise cache-agents against temporary home folders, never the real one."""

import importlib.util
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

try:
    import fcntl
    import pty
    import struct
    import termios
except ImportError:  # no pseudo-terminal on this platform
    pty = None


REPOSITORY = Path(__file__).resolve().parents[5]
SCRIPT = REPOSITORY / "contributors" / "synasapmob" / "tools" / "cache-agents" / "cache-agents.py"

spec = importlib.util.spec_from_file_location("cache_agents", SCRIPT)
ca = importlib.util.module_from_spec(spec)
# The tool's folder is published as it is: a __pycache__ left beside the script would be
# bundled into the catalogue, so importing it here must not write bytecode.
write_bytecode = sys.dont_write_bytecode
sys.dont_write_bytecode = True
try:
    spec.loader.exec_module(ca)
finally:
    sys.dont_write_bytecode = write_bytecode

BLOCK = 20000


def write(path, size=BLOCK):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    return path


def encode(path):
    """How Claude names a project's folder: "/" and "." both become "-"."""
    return str(path).replace("/", "-").replace(".", "-")


def go(browser, *names):
    """Open each named row in turn, whatever order the sizes put them in."""
    for name in names:
        browser.select([row.name for row in browser.rows()].index(name))
        browser.handle_key("right")


def lines_of(browser, width=100, height=30):
    return ["".join(text for text, _ in spans) for spans in browser.render(width, height)]


class HomeTestCase(unittest.TestCase):
    """A home folder with a little of everything an agent leaves behind."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name).resolve() / "home"
        self.home.mkdir()
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("XDG_DATA_HOME", None)
        os.environ["HOME"] = str(self.home)
        self.populate()

    def populate(self):
        claude = self.home / ".claude"
        write(claude / "cache" / "changelog.md")
        write(claude / "cache" / "models.json")
        write(claude / "shell-snapshots" / "snapshot.sh")
        (claude / "telemetry").mkdir(parents=True)
        write(claude / "settings.json")
        write(claude / "skills" / "one" / "SKILL.md")
        (self.home / "code" / "app").mkdir(parents=True)
        write(claude / "projects" / encode(self.home / "code" / "app") / "session.jsonl", 3 * BLOCK)
        write(claude / "projects" / "-gone-project" / "session.jsonl")
        write(self.home / ".codex" / "cache" / "tools.bin", 2 * BLOCK)
        write(self.home / ".codex" / "sessions" / "one.jsonl")
        (self.home / ".gemini" / "empty").mkdir(parents=True)

    def library(self):
        return ca.load(str(self.home))

    def browser(self, **options):
        return ca.Browser(self.library(), lambda: ca.load(str(self.home)), **options)

    def trashed(self):
        files, _ = ca.trash_locations(str(self.home))
        return sorted(os.listdir(files)) if os.path.isdir(files) else []

    def type_phrase(self, browser):
        for character in browser.dialog.phrase:
            browser.handle_key(character)
        browser.handle_key("enter")


class MeasuringTest(HomeTestCase):
    def test_a_file_has_its_size_and_one_path(self):
        entry = ca.scan(str(self.home / ".claude" / "settings.json"), ca.KEEP, "claude", set())

        self.assertGreaterEqual(entry.size, BLOCK)
        self.assertEqual(entry.paths, 1)
        self.assertFalse(entry.is_dir)

    def test_a_folder_adds_up_what_is_inside_it(self):
        entry = ca.scan(str(self.home / ".claude" / "cache"), ca.CACHE, "claude", set())

        self.assertGreaterEqual(entry.size, sum(child.size for child in entry.children))
        self.assertGreaterEqual(entry.size, 2 * BLOCK)
        self.assertEqual(entry.paths, 1 + 2)
        self.assertEqual([child.name for child in entry.children], ["changelog.md", "models.json"])

    def test_an_empty_file_has_no_size_and_is_not_counted(self):
        folder = self.home / "plain"
        write(folder / "full.bin")
        (folder / "empty.bin").write_bytes(b"")

        entry = ca.scan(str(folder), ca.KEEP, None, set())

        self.assertEqual(entry.paths, 2)
        self.assertEqual([child.name for child in entry.visible()], ["full.bin"])

    def test_a_symlink_is_not_followed(self):
        outside = self.home / "outside"
        write(outside / "big.bin", 50 * BLOCK)
        folder = self.home / "linked"
        write(folder / "own.bin")
        os.symlink(outside, folder / "link")

        entry = ca.scan(str(folder), ca.KEEP, None, set())

        self.assertLess(entry.size, 5 * BLOCK)
        link = next(child for child in entry.children if child.name == "link")
        self.assertFalse(link.is_dir)
        self.assertEqual(link.children, [])

    def test_a_hard_linked_file_is_counted_once(self):
        folder = self.home / "twins"
        write(folder / "a.bin")
        os.link(folder / "a.bin", folder / "b.bin")

        entry = ca.scan(str(folder), ca.KEEP, None, set())

        self.assertEqual(sorted(child.size > 0 for child in entry.children), [False, True])
        self.assertEqual(entry.paths, 2)


class FormatTest(unittest.TestCase):
    def test_sizes(self):
        self.assertEqual(ca.format_size(0), "0 B")
        self.assertEqual(ca.format_size(900), "900 B")
        self.assertEqual(ca.format_size(272 * 1024), "272 KB")
        self.assertEqual(ca.format_size(int(5.94 * 1024 * 1024)), "5.9 MB")
        self.assertEqual(ca.format_size(int(1.7 * 1024 ** 3)), "1.7 GB")
        self.assertEqual(ca.format_size(1023 * 1024), "1.0 MB")

    def test_ages(self):
        self.assertEqual(ca.format_age(5), "now")
        self.assertEqual(ca.format_age(-30), "now")
        self.assertEqual(ca.format_age(5 * 60), "5m")
        self.assertEqual(ca.format_age(3 * 3600), "3h")
        self.assertEqual(ca.format_age(41 * 86400), "41d")
        self.assertEqual(ca.format_age(800 * 86400), "2y")

    def test_fit_pads_or_keeps_the_end(self):
        self.assertEqual(ca.fit("ab", 5, ca.UNICODE_CHARS), "ab   ")
        self.assertEqual(ca.fit("abcdefgh", 5, ca.UNICODE_CHARS), "abcd…")
        self.assertEqual(ca.fit("abcdefgh", 5, ca.UNICODE_CHARS, tail=True), "…efgh")
        self.assertEqual(len(ca.fit("abcdefgh", 5, ca.ASCII_CHARS, tail=True)), 5)


class ProjectNameTest(HomeTestCase):
    def test_a_name_is_decoded_to_the_path_that_exists(self):
        folder = encode(self.home / "code" / "app")

        self.assertEqual(ca.decode_project(folder, str(self.home)), "~/code/app")

    def test_a_dash_in_a_name_is_not_taken_for_a_slash(self):
        (self.home / "code" / "hub-william").mkdir()

        folder = encode(self.home / "code" / "hub-william")

        self.assertEqual(ca.decode_project(folder, str(self.home)), "~/code/hub-william")

    def test_a_dot_folder_is_found(self):
        (self.home / "code" / ".claude" / "worktrees" / "fix").mkdir(parents=True)

        folder = encode(self.home / "code" / ".claude" / "worktrees" / "fix")

        self.assertEqual(ca.decode_project(folder, str(self.home)), "~/code/.claude/worktrees/fix")

    def test_a_path_that_is_gone_keeps_its_raw_name(self):
        self.assertEqual(ca.decode_project("-gone-project", str(self.home)), "-gone-project")
        self.assertEqual(ca.decode_project("plain", str(self.home)), "plain")


class LoadingTest(HomeTestCase):
    def test_every_supported_agent_is_listed_largest_first_then_by_name(self):
        library = self.library()

        self.assertEqual(
            [agent.name for agent in library.root.visible()],
            ["claude", "codex", "dsh", "gemini", "grok", "omp", "opencode"],
        )
        statuses = dict((agent.name, ca.entry_status(agent)) for agent in library.root.visible())
        self.assertEqual(statuses["gemini"], "empty")
        for name in ("dsh", "grok", "omp", "opencode"):
            self.assertEqual(statuses[name], "missing", name)

    def test_an_agent_that_is_not_installed_is_still_listed_but_cannot_be_opened(self):
        shutil.rmtree(self.home / ".codex")
        browser = self.browser()
        browser.select([row.name for row in browser.rows()].index("codex"))

        self.assertEqual(ca.entry_status(browser.current()), "missing")
        browser.handle_key("right")

        self.assertEqual(len(browser.stack), 1)
        self.assertIn("codex is not installed", browser.message)

    def test_claude_is_global_then_projects_by_size(self):
        claude = self.library().root.visible()[0]

        self.assertEqual([child.name for child in claude.visible()], ["Global", "~/code/app", "-gone-project"])

    def test_an_agent_without_projects_lists_its_entries_directly(self):
        codex = next(agent for agent in self.library().root.visible() if agent.name == "codex")

        self.assertEqual([child.name for child in codex.visible()], ["cache", "sessions"])

    def test_only_listed_folders_are_cache(self):
        library = self.library()

        removable = sorted((item.agent, item.name) for item in ca.prunable(library.root))

        self.assertEqual(
            removable,
            [("claude", "cache"), ("claude", "shell-snapshots"), ("claude", "telemetry"), ("codex", "cache")],
        )

    def test_projects_and_settings_are_never_cache(self):
        claude = self.library().root.visible()[0]
        shared = claude.visible()[0]

        self.assertEqual(ca.entry_status(shared), ca.MIXED)
        self.assertEqual(ca.entry_status(claude.visible()[1]), ca.KEEP)
        settings = next(child for child in shared.children if child.name == "settings.json")
        self.assertEqual(ca.prunable(settings), [])

    def test_a_cache_folder_inside_a_project_is_not_cache(self):
        write(self.home / ".claude" / "projects" / "-gone-project" / "cache" / "x.bin")

        project = next(c for c in self.library().root.visible()[0].children if c.name == "-gone-project")

        self.assertEqual(ca.prunable(project), [])

    def test_totals_add_up_between_screens(self):
        library = self.library()

        for agent in library.root.visible():
            self.assertEqual(agent.paths, sum(child.paths for child in agent.visible()), agent.name)
            self.assertEqual(agent.size, sum(child.size for child in agent.visible()), agent.name)


class BrowsingTest(HomeTestCase):
    def test_right_opens_and_left_goes_back_to_the_same_row(self):
        browser = self.browser()
        browser.handle_key("down")
        browser.handle_key("right")

        self.assertEqual([entry.name for entry in browser.stack], ["cache-agents", "codex"])
        browser.handle_key("left")

        self.assertEqual(len(browser.stack), 1)
        self.assertEqual(browser.current().name, "codex")

    def test_the_cursor_stays_inside_the_list(self):
        browser = self.browser()
        browser.handle_key("up")
        self.assertEqual(browser.current().name, "claude")
        for _ in range(20):
            browser.handle_key("down")
        self.assertEqual(browser.current().name, "opencode")
        browser.handle_key("home")
        self.assertEqual(browser.current().name, "claude")
        browser.handle_key("end")
        self.assertEqual(browser.current().name, "opencode")

    def test_nothing_with_no_size_is_ever_listed(self):
        browser = self.browser()
        seen = []
        stack = list(browser.library.root.visible())  # agents are listed even without a size
        while stack:
            node = stack.pop()
            for child in node.visible():
                seen.append(child)
                stack.append(child)

        self.assertTrue(seen)
        self.assertTrue(all(entry.size > 0 and entry.paths > 0 for entry in seen))
        screen = "\n".join(lines_of(browser))
        self.assertNotIn("telemetry", screen)
        self.assertNotIn(" 0 B", screen)

    def test_lowercase_d_asks_for_a_capital(self):
        browser = self.browser()
        browser.handle_key("d")

        self.assertIsNone(browser.dialog)
        self.assertIn("Shift+d", browser.message)

    def test_the_disk_tab_is_a_placeholder(self):
        browser = self.browser()
        browser.handle_key("1")
        screen = "\n".join(lines_of(browser))

        self.assertIn("not available yet", screen)
        browser.handle_key("D")
        self.assertIsNone(browser.dialog)
        browser.handle_key("2")
        self.assertIn("claude", "\n".join(lines_of(browser)))

    def test_q_quits(self):
        browser = self.browser()
        browser.handle_key("q")

        self.assertFalse(browser.running)

    def test_rescan_returns_to_the_same_place(self):
        browser = self.browser()
        browser.handle_key("right")
        browser.handle_key("right")
        write(self.home / ".claude" / "cache" / "later.bin")

        browser.handle_key("r")

        self.assertEqual([entry.name for entry in browser.stack], ["cache-agents", "claude", "Global"])
        self.assertIn("Scanned again", browser.message)


class RenderingTest(HomeTestCase):
    def widths(self, browser, width, height):
        return {sum(len(text) for text, _ in spans) for spans in browser.render(width, height)}

    def test_every_line_is_exactly_the_screen_wide(self):
        for ascii_only in (False, True):
            browser = self.browser(ascii_only=ascii_only)
            for width, height in ((64, 12), (100, 30), (160, 50)):
                self.assertEqual(self.widths(browser, width, height), {width}, (ascii_only, width, height))
            browser.handle_key("D")
            self.assertEqual(self.widths(browser, 100, 30), {100})

    def test_the_home_screen_shows_the_columns_and_what_delete_would_free(self):
        screen = "\n".join(lines_of(self.browser()))

        for text in ("NAME", "PATHS", "SIZE", "AGE", "KIND", "claude", "codex", "[2 cache-agents]", "[D] delete all cache"):
            self.assertIn(text, screen)

    def test_the_breadcrumb_names_where_you_are(self):
        browser = self.browser()
        browser.handle_key("right")
        browser.handle_key("right")
        screen = "\n".join(lines_of(browser))

        self.assertIn("cache-agents › claude › Global", screen)

    def test_a_long_list_scrolls_with_the_cursor(self):
        for number in range(40):
            write(self.home / ".gemini" / "many" / ("file-%02d.bin" % number), BLOCK + number * 4096)
        browser = self.browser()
        go(browser, "gemini", "many")
        self.assertEqual(browser.stack[-1].name, "many")
        for _ in range(30):
            browser.handle_key("down")

        screen = lines_of(browser, 100, 20)
        marked = [line for line in screen if line.startswith("\u2502 > ")]

        self.assertEqual(len(screen), 20)
        self.assertEqual(len(marked), 1)
        self.assertIn(browser.current().name, marked[0])
        self.assertGreater(browser.scroll[browser.key()], 0)

    def test_a_small_terminal_gets_a_message_not_a_broken_screen(self):
        screen = lines_of(self.browser(), 40, 8)

        self.assertEqual(len(screen), 1)
        self.assertIn("Terminal too small", screen[0])

    def test_a_home_with_no_agents_lists_them_all_as_missing(self):
        shutil.rmtree(self.home / ".claude")
        shutil.rmtree(self.home / ".codex")
        shutil.rmtree(self.home / ".gemini")

        screen = "\n".join(lines_of(self.browser()))

        for name in ("claude", "codex", "gemini", "opencode", "dsh", "grok", "omp"):
            self.assertRegex(screen, name + r"\s+-\s+-\s+-\s+missing")


class DeletingTest(HomeTestCase):
    def test_delete_all_needs_the_size_typed_and_moves_only_cache(self):
        browser = self.browser()
        browser.handle_key("D")

        self.assertIsNotNone(browser.dialog)
        self.assertRegex(browser.dialog.phrase, r"^DELETE \d+(\.\d)?(KB|MB)$")
        preview = "\n".join(lines_of(browser))
        self.assertIn("will move to the Trash", preview)
        self.assertIn("kept, not cache", preview)
        self.assertIn("Quit any agent that is running first", preview)
        self.assertEqual(self.trashed(), [])

        browser.handle_key("enter")
        self.assertIn("does not match", "\n".join(lines_of(browser)))
        self.assertTrue((self.home / ".claude" / "cache").exists())

        self.type_phrase(browser)

        self.assertIsNone(browser.dialog)
        self.assertIn("Moved", browser.message)
        self.assertFalse((self.home / ".claude" / "cache").exists())
        self.assertFalse((self.home / ".claude" / "shell-snapshots").exists())
        self.assertFalse((self.home / ".codex" / "cache").exists())
        self.assertEqual(self.trashed(), ["claude-cache", "claude-shell-snapshots", "codex-cache"])
        for kept in (
            self.home / ".claude" / "settings.json",
            self.home / ".claude" / "skills" / "one" / "SKILL.md",
            self.home / ".claude" / "projects" / "-gone-project" / "session.jsonl",
            self.home / ".codex" / "sessions" / "one.jsonl",
        ):
            self.assertTrue(kept.exists(), kept)

    def test_a_wrong_phrase_never_deletes(self):
        browser = self.browser()
        browser.handle_key("D")
        for character in "delete":
            browser.handle_key(character)
        browser.handle_key("enter")
        browser.handle_key("esc")

        self.assertIsNone(browser.dialog)
        self.assertIn("Nothing was deleted", browser.message)
        self.assertTrue((self.home / ".claude" / "cache").exists())
        self.assertEqual(self.trashed(), [])

    def test_backspace_corrects_the_phrase(self):
        browser = self.browser()
        browser.handle_key("D")
        browser.handle_key("x")
        browser.handle_key("backspace")

        self.assertEqual(browser.dialog.typed, "")

    def test_the_screen_is_rebuilt_after_deleting(self):
        browser = self.browser()
        before = browser.library.root.size
        browser.handle_key("D")
        self.type_phrase(browser)

        self.assertLess(browser.library.root.size, before)
        self.assertEqual([agent.name for agent in browser.rows()][:2], ["claude", "codex"])

    def test_global_of_one_agent_asks_yes_or_no_and_leaves_other_agents_alone(self):
        browser = self.browser()
        browser.handle_key("right")
        self.assertEqual(browser.current().name, "Global")

        browser.handle_key("D")

        self.assertIsNone(browser.dialog.phrase)
        self.assertIn("[y/N]", "\n".join(lines_of(browser)))
        browser.handle_key("y")

        self.assertFalse((self.home / ".claude" / "cache").exists())
        self.assertTrue((self.home / ".codex" / "cache").exists())
        self.assertTrue((self.home / ".claude" / "settings.json").exists())

    def test_anything_but_y_cancels(self):
        for key in ("n", "enter", "esc", "x"):
            browser = self.browser()
            browser.handle_key("right")
            browser.handle_key("D")
            browser.handle_key(key)

            self.assertIsNone(browser.dialog, key)
            self.assertTrue((self.home / ".claude" / "cache").exists(), key)

    def test_one_item_inside_a_cache_folder_can_be_deleted_alone(self):
        browser = self.browser()
        for key in ("right", "right", "right"):
            browser.handle_key(key)
        self.assertEqual(browser.stack[-1].name, "cache")
        self.assertEqual(browser.current().name, "changelog.md")

        browser.handle_key("D")
        browser.handle_key("y")

        self.assertFalse((self.home / ".claude" / "cache" / "changelog.md").exists())
        self.assertTrue((self.home / ".claude" / "cache" / "models.json").exists())
        self.assertEqual(browser.stack[-1].name, "cache")
        self.assertEqual(browser.current().name, "models.json")

    def test_data_cannot_be_deleted_at_any_level(self):
        browser = self.browser()
        for key in ("right", "down", "enter"):
            browser.handle_key(key)
        self.assertEqual(browser.stack[-1].name, "~/code/app")

        browser.handle_key("D")
        self.assertIsNone(browser.dialog)
        self.assertIn("holds data, not cache", browser.message)
        self.assertIn("nothing to delete here", "\n".join(lines_of(browser)))
        self.assertTrue((self.home / ".claude" / "projects").exists())

    def test_nothing_to_delete_when_there_is_no_cache(self):
        shutil.rmtree(self.home / ".claude" / "cache")
        shutil.rmtree(self.home / ".claude" / "shell-snapshots")
        shutil.rmtree(self.home / ".codex" / "cache")
        browser = self.browser()

        browser.handle_key("D")

        self.assertIsNone(browser.dialog)
        self.assertIn("Nothing to delete", browser.message)

    def test_trash_names_never_collide(self):
        for _ in range(2):
            write(self.home / ".claude" / "cache" / "again.bin")
            browser = self.browser()
            browser.handle_key("right")
            browser.handle_key("D")
            browser.handle_key("y")

        self.assertEqual(
            [name for name in self.trashed() if name.startswith("claude-cache")],
            ["claude-cache", "claude-cache 2"],
        )

    def test_the_freedesktop_trash_gets_an_info_file(self):
        with mock.patch.object(ca.sys, "platform", "linux"):
            browser = self.browser()
            browser.handle_key("right")
            browser.handle_key("D")
            browser.handle_key("y")
            files, info = ca.trash_locations(str(self.home))

        self.assertEqual(files, str(self.home / ".local" / "share" / "Trash" / "files"))
        self.assertTrue((Path(files) / "claude-cache" / "changelog.md").exists())
        text = (Path(info) / "claude-cache.trashinfo").read_text()
        self.assertTrue(text.startswith("[Trash Info]\nPath="))
        self.assertIn("DeletionDate=", text)
        self.assertIn(".claude/cache", text)

    def test_xdg_data_home_moves_the_freedesktop_trash(self):
        with mock.patch.object(ca.sys, "platform", "linux"):
            with mock.patch.dict(os.environ, {"XDG_DATA_HOME": str(self.home / "data")}):
                files, info = ca.trash_locations(str(self.home))

        self.assertEqual(files, str(self.home / "data" / "Trash" / "files"))
        self.assertEqual(info, str(self.home / "data" / "Trash" / "info"))

    def test_macos_uses_the_trash_folder_in_the_home(self):
        with mock.patch.object(ca.sys, "platform", "darwin"):
            self.assertEqual(ca.trash_locations(str(self.home)), (str(self.home / ".Trash"), None))


class GuardTest(HomeTestCase):
    def plan_for(self, library, *names):
        claude = next(agent for agent in library.root.visible() if agent.name == "claude")
        shared = claude.visible()[0]
        items = [child for child in shared.children if child.name in names]
        return ca.Plan("test", items, 0)

    def test_a_cache_swapped_for_a_symlink_is_refused_and_its_target_survives(self):
        library = self.library()
        plan = self.plan_for(library, "cache")
        precious = self.home / "precious"
        write(precious / "keep.txt")
        shutil.rmtree(self.home / ".claude" / "cache")
        os.symlink(precious, self.home / ".claude" / "cache")

        moved, failed = ca.run_plan(plan, library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["reached through a symlink"])
        self.assertTrue((precious / "keep.txt").exists())
        self.assertEqual(self.trashed(), [])

    def test_a_folder_that_is_not_cache_is_refused(self):
        library = self.library()
        plan = self.plan_for(library, "settings.json", "skills")

        moved, failed = ca.run_plan(plan, library)

        self.assertEqual(moved, [])
        self.assertEqual({reason for _, reason in failed}, {"not a cache"})
        self.assertTrue((self.home / ".claude" / "settings.json").exists())
        self.assertTrue((self.home / ".claude" / "skills").exists())

    def test_a_forged_cache_kind_on_a_non_cache_name_is_still_refused(self):
        library = self.library()
        plan = self.plan_for(library, "settings.json")
        plan.items[0].kind = ca.CACHE

        moved, failed = ca.run_plan(plan, library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["not a cache"])
        self.assertTrue((self.home / ".claude" / "settings.json").exists())

    def test_a_path_outside_the_agent_folder_is_refused(self):
        library = self.library()
        outside = self.home / "outside"
        write(outside / "x.bin")
        root = os.path.realpath(self.home / ".claude")
        entry = ca.scan(str(outside), ca.CACHE, "claude", set(), root)

        moved, failed = ca.run_plan(ca.Plan("test", [entry], 0), library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["outside the agent folder"])
        self.assertTrue(outside.exists())

    def test_something_deleted_since_the_scan_is_reported_not_fatal(self):
        library = self.library()
        plan = self.plan_for(library, "cache", "shell-snapshots")
        shutil.rmtree(self.home / ".claude" / "cache")

        moved, failed = ca.run_plan(plan, library)

        self.assertEqual([entry.name for entry in moved], ["shell-snapshots"])
        self.assertEqual([reason for _, reason in failed], ["already gone"])

    def test_a_failed_move_is_never_turned_into_a_permanent_delete(self):
        library = self.library()
        plan = self.plan_for(library, "cache")

        with mock.patch.object(ca.shutil, "move", side_effect=PermissionError("denied")):
            moved, failed = ca.run_plan(plan, library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["denied"])
        self.assertTrue((self.home / ".claude" / "cache" / "changelog.md").exists())


class CommandLineTest(HomeTestCase):
    def run_script(self, *args, **options):
        environment = {key: value for key, value in os.environ.items() if key != "XDG_DATA_HOME"}
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=60,
            **options,
        )

    def test_list_prints_the_table_and_changes_nothing(self):
        def snapshot():
            return sorted(str(path) for path in self.home.rglob("*") if "Library" not in path.parts)

        before = snapshot()

        result = self.run_script("--list", "--home", str(self.home))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"cache-agents\s+total [\d.]+ (KB|MB), \d+ paths")
        self.assertRegex(result.stdout, r"claude\s+\d+\s+[\d.]+ (KB|MB)\s+now\s+mixed")
        self.assertRegex(result.stdout, r"codex\s+\d+\s+[\d.]+ (KB|MB)\s+now\s+mixed")
        self.assertRegex(result.stdout, r"gemini\s+-\s+-\s+-\s+empty")
        self.assertRegex(result.stdout, r"opencode\s+-\s+-\s+-\s+missing")
        self.assertEqual(snapshot(), before)

    def test_list_for_one_agent_shows_global_and_projects(self):
        result = self.run_script("--list", "--agent=claude", "--home", str(self.home))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("cache-agents > claude", result.stdout)
        self.assertIn("Global", result.stdout)
        self.assertIn("~/code/app", result.stdout)

    def test_an_unknown_agent_is_an_error(self):
        result = self.run_script("--agent=nope", "--home", str(self.home))

        self.assertEqual(result.returncode, 2)
        self.assertIn("no agent named", result.stderr)

    def test_without_a_terminal_it_says_to_use_list(self):
        result = self.run_script("--home", str(self.home))

        self.assertEqual(result.returncode, 2)
        self.assertIn("--list", result.stderr)

    def test_an_empty_home_is_not_an_error(self):
        empty = self.home / "empty"
        empty.mkdir()

        result = self.run_script("--list", "--home", str(empty))

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.count("missing"), 7)

    def test_the_tool_folder_holds_only_the_script(self):
        """The catalogue publishes every file in the folder, so no bytecode may sit beside it."""
        self.assertEqual(sorted(os.listdir(SCRIPT.parent)), ["cache-agents.py"])
        self.assertFalse(os.access(SCRIPT, os.X_OK), "published scripts are not executable")

    def test_the_catalogue_can_read_the_script_header(self):
        lines = []
        for line in SCRIPT.read_text().split("\n"):
            if line.startswith("#!"):
                continue
            if not line.startswith("#"):
                break
            lines.append(re.sub(r"^#\s?", "", line))

        self.assertTrue(lines[0].startswith("cache-agents: "))
        self.assertEqual(lines[1], "")
        self.assertIn("terminal browser", lines[2])


class PositionTest(HomeTestCase):
    """The cursor of each folder is remembered while the tool runs, and only then."""

    def test_a_folder_remembers_the_cursor_when_you_come_back_to_it(self):
        browser = self.browser()
        go(browser, "claude", "Global")
        browser.handle_key("down")
        browser.handle_key("down")
        inside = browser.current().name
        self.assertNotEqual(inside, browser.rows()[0].name)

        browser.handle_key("left")
        self.assertEqual(browser.current().name, "Global")
        browser.handle_key("right")

        self.assertEqual(browser.current().name, inside)

    def test_each_folder_keeps_its_own_cursor(self):
        browser = self.browser()
        go(browser, "claude", "Global")
        browser.handle_key("down")
        in_global = browser.current().name
        browser.handle_key("left")
        browser.handle_key("down")
        browser.handle_key("right")
        self.assertEqual(browser.current().name, "session.jsonl")
        browser.handle_key("left")
        browser.handle_key("up")
        browser.handle_key("right")

        self.assertEqual(browser.current().name, in_global)

    def test_the_position_survives_a_rescan(self):
        browser = self.browser()
        go(browser, "claude", "Global")
        browser.handle_key("down")
        name = browser.current().name

        browser.handle_key("r")

        self.assertEqual(browser.current().name, name)
        self.assertEqual([entry.name for entry in browser.stack], ["cache-agents", "claude", "Global"])

    def test_deleting_the_row_under_the_cursor_leaves_the_cursor_nearby(self):
        browser = self.browser()
        go(browser, "claude", "Global")
        browser.select([row.name for row in browser.rows()].index("cache"))
        before = browser.index()

        browser.handle_key("D")
        browser.handle_key("y")

        rows = browser.rows()
        self.assertNotIn("cache", [row.name for row in rows])
        self.assertEqual(browser.index(), min(before, len(rows) - 1))

    def test_a_new_run_starts_from_the_top(self):
        browser = self.browser()
        go(browser, "claude", "Global")
        browser.handle_key("down")

        fresh = self.browser()

        self.assertEqual(len(fresh.stack), 1)
        self.assertEqual(fresh.index(), 0)


class ViewerTest(HomeTestCase):
    """Reading a file: text only, read-only, and careful with what it shows."""

    def setUp(self):
        super().setUp()
        self.docs = self.home / ".gemini" / "docs"
        self.put("note.txt", "\n".join("line %d" % number for number in range(1, 101)).encode())
        self.put("data.json", b'{"a": 1, "b": [1, 2, 3], "name": "x"}')
        self.put("log.jsonl", b'{"n": 1}\n{"n": 2, "tags": ["a"]}\nnot json\n')
        self.put("picture.png", b"\x89PNG\r\n\x1a\n" + b"\0" * 30000)
        self.put("image.dmg", b"\xff\xfe" * 12000)
        self.put("mcp-auth.json", b'{"token": "s3cret-value"}')
        self.put("big.log", "".join("log line %06d\n" % number for number in range(30000)).encode())
        self.put("escape.txt", b"plain \x1b[31mred\x1b[0m bell\x07 end\n")
        self.put("long.txt", b"w" * 500 + b"\nshort\n")
        self.put("accents.txt", "\u00e9".encode() * 200000)

    def put(self, name, data):
        self.docs.mkdir(parents=True, exist_ok=True)
        (self.docs / name).write_bytes(data)

    def open_file(self, name):
        browser = self.browser()
        go(browser, "gemini", "docs", name)
        return browser

    def screen(self, browser, width=100, height=20):
        return "\n".join(lines_of(browser, width, height))

    def test_a_text_file_opens_and_scrolls(self):
        browser = self.open_file("note.txt")

        self.assertIsNotNone(browser.viewer)
        self.assertRegex(self.screen(browser), r"\u2502\s+1 line 1\s+\u2502")
        for _ in range(3):
            browser.handle_key("down")
        self.assertRegex(self.screen(browser), r"\u2502\s+4 line 4\s+\u2502")
        browser.handle_key("end")
        self.assertIn("line 100", self.screen(browser))
        for _ in range(5):
            browser.handle_key("down")
        self.assertIn("line 100", self.screen(browser))
        browser.handle_key("home")
        self.assertRegex(self.screen(browser), r"\u2502\s+1 line 1\s+\u2502")
        browser.handle_key("pagedown")
        self.assertNotIn("line 1 ", self.screen(browser))

    def test_left_goes_back_to_the_list_with_the_cursor_on_the_file(self):
        browser = self.open_file("note.txt")

        browser.handle_key("left")

        self.assertIsNone(browser.viewer)
        self.assertEqual(browser.current().name, "note.txt")
        self.assertEqual(browser.stack[-1].name, "docs")

    def test_a_json_file_is_pretty_printed_and_p_shows_it_raw(self):
        browser = self.open_file("data.json")

        pretty = self.screen(browser)
        self.assertIn('"a": 1,', pretty)
        self.assertNotIn('{"a": 1, "b"', pretty)
        browser.handle_key("p")

        self.assertIn('{"a": 1, "b": [1, 2, 3], "name": "x"}', self.screen(browser))

    def test_a_jsonl_file_shows_one_record_per_line_and_p_spreads_them(self):
        browser = self.open_file("log.jsonl")

        raw = self.screen(browser)
        self.assertIn('{"n": 1}', raw)
        self.assertIn('{"n": 2, "tags": ["a"]}', raw)
        browser.handle_key("p")

        pretty = self.screen(browser, 100, 30)
        self.assertIn('"n": 2,', pretty)
        self.assertIn("not json", pretty)

    def test_p_on_plain_text_says_it_cannot(self):
        browser = self.open_file("note.txt")
        self.assertNotIn("pretty-print", self.screen(browser))

        browser.handle_key("p")

        self.assertIn("Only .json and .jsonl", self.screen(browser))

    def test_files_that_are_not_text_are_not_opened(self):
        for name in ("picture.png", "image.dmg"):
            browser = self.open_file(name)

            self.assertIsNone(browser.viewer, name)
            self.assertIn("is not readable text", browser.message, name)
            self.assertEqual(browser.current().name, name)

    def test_a_credential_file_asks_before_showing_anything(self):
        browser = self.open_file("mcp-auth.json")

        gate = self.screen(browser)
        self.assertIn("may contain secrets", gate)
        self.assertNotIn("s3cret-value", gate)
        browser.handle_key("down")
        browser.handle_key("p")
        self.assertNotIn("s3cret-value", self.screen(browser))
        browser.handle_key("enter")

        self.assertIn("s3cret-value", self.screen(browser))

    def test_escape_leaves_the_gate_without_showing_the_file(self):
        browser = self.open_file("mcp-auth.json")

        browser.handle_key("esc")

        self.assertIsNone(browser.viewer)
        self.assertNotIn("s3cret-value", self.screen(browser))

    def test_only_the_start_of_a_big_file_is_read(self):
        browser = self.open_file("big.log")

        self.assertIn("first 256 KB of", self.screen(browser))
        browser.handle_key("end")
        self.assertNotIn("log line 029999", self.screen(browser))

    def test_a_character_cut_at_the_limit_does_not_hide_the_file(self):
        document = ca.read_document(str(self.docs / "accents.txt"))

        self.assertIsInstance(document, ca.Document)
        self.assertTrue(document.truncated)
        self.assertTrue(document.text.startswith("\u00e9"))

    def test_control_characters_never_reach_the_screen(self):
        screen = self.screen(self.open_file("escape.txt"))

        self.assertNotIn("\x1b", screen)
        self.assertNotIn("\x07", screen)
        self.assertIn("red", screen)

    def test_a_long_line_wraps_inside_the_screen(self):
        browser = self.open_file("long.txt")
        rows = browser.viewer.wrapped(80 - 2 - 8)

        self.assertEqual(rows[0][0], 1)
        self.assertIsNone(rows[1][0])
        self.assertTrue(all(len(text) <= 70 for _, text in rows))
        self.assertIn(2, [number for number, _ in rows])

    def test_every_viewer_line_is_exactly_the_screen_wide(self):
        for name in ("note.txt", "mcp-auth.json"):
            for width, height in ((64, 12), (100, 30)):
                browser = self.open_file(name)
                widths = {sum(len(text) for text, _ in spans) for spans in browser.render(width, height)}
                self.assertEqual(widths, {width}, (name, width, height))

    def test_the_viewer_cannot_delete_anything(self):
        browser = self.open_file("note.txt")
        before = (self.docs / "note.txt").read_bytes()

        browser.handle_key("D")

        self.assertIsNone(browser.dialog)
        self.assertIn("read-only", browser.message)
        self.assertEqual((self.docs / "note.txt").read_bytes(), before)
        browser.handle_key("q")
        self.assertFalse(browser.running)

    def test_symlinks_and_pipes_are_not_read(self):
        os.symlink(self.docs / "note.txt", self.docs / "link.txt")

        self.assertEqual(
            ca.read_document(str(self.docs / "link.txt")), "is a symlink, which is not followed"
        )
        if hasattr(os, "mkfifo"):
            os.mkfifo(self.docs / "pipe")
            self.assertEqual(ca.read_document(str(self.docs / "pipe")), "is not a regular file")

    def test_names_that_look_like_credentials(self):
        for name in ("mcp-auth.json", ".credentials.json", "oauth_token.json", ".env", "server.pem",
                     "id_rsa", "API.KEY", "secrets.yml"):
            self.assertTrue(ca.looks_secret(name), name)
        for name in ("AUTHORS.md", "settings.json", "session.jsonl", "tokenizer.json", "note.txt"):
            self.assertFalse(ca.looks_secret(name), name)


class AgentsTest(HomeTestCase):
    """Agents with more than one folder, and agents that are missing or empty."""

    def add_opencode(self):
        write(self.home / ".config" / "opencode" / "opencode.json", BLOCK)
        write(self.home / ".local" / "share" / "opencode" / "opencode.db", 5 * BLOCK)
        write(self.home / ".cache" / "opencode" / "models.json", 2 * BLOCK)
        write(self.home / ".opencode" / "bin" / "opencode", 3 * BLOCK)

    def test_an_agent_with_several_folders_shows_one_row_for_each(self):
        self.add_opencode()
        browser = self.browser()

        go(browser, "opencode")

        self.assertEqual(
            [row.name for row in browser.rows()],
            ["~/.local/share/opencode", "~/.opencode", "~/.cache/opencode", "~/.config/opencode"],
        )

    def test_only_the_opencode_cache_folder_is_cache(self):
        self.add_opencode()

        removable = sorted((item.agent, item.name) for item in ca.prunable(self.library().root))

        self.assertIn(("opencode", "models.json"), removable)
        self.assertNotIn(("opencode", "opencode.db"), removable)
        self.assertNotIn(("opencode", "opencode.json"), removable)
        self.assertNotIn(("opencode", "bin"), removable)

    def test_delete_on_the_cache_folder_moves_only_its_files(self):
        self.add_opencode()
        browser = self.browser()
        go(browser, "opencode")
        browser.select([row.name for row in browser.rows()].index("~/.cache/opencode"))

        browser.handle_key("D")
        browser.handle_key("y")

        self.assertFalse((self.home / ".cache" / "opencode" / "models.json").exists())
        self.assertTrue((self.home / ".local" / "share" / "opencode" / "opencode.db").exists())
        self.assertTrue((self.home / ".config" / "opencode" / "opencode.json").exists())
        self.assertIn("opencode-models.json", self.trashed())

    def test_delete_on_a_data_folder_of_opencode_is_refused(self):
        self.add_opencode()
        browser = self.browser()
        go(browser, "opencode")
        browser.select([row.name for row in browser.rows()].index("~/.local/share/opencode"))

        browser.handle_key("D")

        self.assertIsNone(browser.dialog)
        self.assertIn("holds data, not cache", browser.message)

    def test_dsh_grok_and_omp_can_be_browsed_but_have_no_cache(self):
        write(self.home / ".dsh" / "profiles" / "a.bin")
        write(self.home / ".dsh-tui" / "history.jsonl")
        write(self.home / ".grok" / "config.toml")
        write(self.home / ".omp" / "agent" / "models.yml")
        library = self.library()
        agents = dict((agent.name, agent) for agent in library.root.visible())

        for name in ("dsh", "grok", "omp"):
            self.assertEqual(ca.entry_status(agents[name]), ca.KEEP, name)
            self.assertEqual(ca.prunable(agents[name]), [], name)
        self.assertEqual([row.name for row in agents["dsh"].visible()], ["~/.dsh", "~/.dsh-tui"])

    def test_an_empty_agent_is_listed_but_cannot_be_opened(self):
        browser = self.browser()
        browser.select([row.name for row in browser.rows()].index("gemini"))

        browser.handle_key("right")

        self.assertEqual(len(browser.stack), 1)
        self.assertIn("gemini is empty", browser.message)
        self.assertIn("empty", self.row_of(browser, "gemini"))

    def row_of(self, browser, name):
        return next(
            line for line in lines_of(browser)
            if line.startswith("\u2502") and line[1:].strip(" >").startswith(name)
        )

    def test_missing_and_empty_rows_show_dashes_not_zeros(self):
        browser = self.browser()

        for name in ("gemini", "opencode", "dsh", "grok", "omp"):
            row = self.row_of(browser, name)
            self.assertNotIn(" 0 B", row, name)
            self.assertRegex(row, r"-\s+-\s+-\s+(missing|empty)", name)

    def test_delete_all_only_offers_what_exists(self):
        browser = self.browser()
        browser.handle_key("D")
        preview = "\n".join(lines_of(browser))

        for text in ("claude", "codex"):
            self.assertIn(text, preview)
        for text in ("opencode", "gemini", "grok", "omp", "dsh"):
            self.assertNotIn("%s  ~/" % text, preview)


@unittest.skipIf(pty is None, "needs a pseudo-terminal")
class TerminalTest(HomeTestCase):
    """Drive the real curses screen through a pseudo-terminal."""

    def start(self, rows=30, columns=100):
        environment = {key: value for key, value in os.environ.items() if key != "XDG_DATA_HOME"}
        environment.update({"TERM": "xterm-256color", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
        pid, descriptor = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            os.execve(sys.executable, [sys.executable, str(SCRIPT), "--home", str(self.home)], environment)
        self.addCleanup(self.finish, pid, descriptor)
        self.output = b""
        return pid, descriptor

    def finish(self, pid, descriptor):
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass

    def read_until(self, descriptor, pattern, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            ready, _, _ = select.select([descriptor], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(descriptor, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.output += chunk
            if re.search(pattern, self.output):
                return True
        return False

    def wait_for_exit(self, pid, descriptor, timeout=20):
        """Keep reading while waiting: a full pty buffer would block the child's shutdown."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                return os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
            ready, _, _ = select.select([descriptor], [], [], 0.1)
            if ready:
                try:
                    self.output += os.read(descriptor, 65536)
                except OSError:
                    pass
        return None

    def test_the_screen_draws_and_q_quits_cleanly(self):
        pid, descriptor = self.start()

        self.assertTrue(self.read_until(descriptor, rb"delete all cache"), self.output[-400:])
        self.assertIn(b"2 cache-agents", self.output)
        os.write(descriptor, b"q")

        self.assertEqual(self.wait_for_exit(pid, descriptor), 0)

    def test_delete_all_works_end_to_end_through_the_keyboard(self):
        pid, descriptor = self.start()
        self.assertTrue(self.read_until(descriptor, rb"delete all cache"), self.output[-400:])

        os.write(descriptor, b"D")
        self.assertTrue(self.read_until(descriptor, rb"Type\s+DELETE [0-9.]+(KB|MB)"), self.output[-400:])
        phrase = re.search(rb"DELETE [0-9.]+(KB|MB)", self.output).group(0)
        os.write(descriptor, phrase + b"\r")

        self.assertTrue(self.read_until(descriptor, rb"Moved"), self.output[-400:])
        os.write(descriptor, b"q")
        self.assertEqual(self.wait_for_exit(pid, descriptor), 0)
        self.assertFalse((self.home / ".claude" / "cache").exists())
        self.assertTrue((self.home / ".claude" / "settings.json").exists())
        self.assertIn("claude-cache", self.trashed())

    def test_browsing_writes_nothing_to_the_home_folder(self):
        def snapshot():
            return sorted(str(path) for path in self.home.rglob("*") if "Library" not in path.parts)

        before = snapshot()
        pid, descriptor = self.start()
        self.assertTrue(self.read_until(descriptor, rb"delete all cache"), self.output[-400:])
        for key in (b"\x1bOC", b"\x1bOB", b"\x1bOC", b"\x1bOD", b"\x1bOD"):
            os.write(descriptor, key)
            time.sleep(0.15)
        os.write(descriptor, b"q")

        self.assertEqual(self.wait_for_exit(pid, descriptor), 0)
        self.assertEqual(snapshot(), before)

    def test_a_piped_script_still_gets_the_keyboard(self):
        """curl | python3 leaves stdin at end of file, so the tool reads /dev/tty instead."""
        environment = {key: value for key, value in os.environ.items() if key != "XDG_DATA_HOME"}
        environment.update({"TERM": "xterm-256color", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
        pid, descriptor = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
            command = '%s - --home %s < "%s"' % (sys.executable, self.home, SCRIPT)
            os.execve("/bin/sh", ["/bin/sh", "-c", command], environment)
        self.addCleanup(self.finish, pid, descriptor)
        self.output = b""

        self.assertTrue(self.read_until(descriptor, rb"delete all cache"), self.output[-400:])
        os.write(descriptor, b"q")

        self.assertEqual(self.wait_for_exit(pid, descriptor), 0)


if __name__ == "__main__":
    unittest.main()
