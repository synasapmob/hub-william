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
        browser.cursors[-1] = [row.name for row in browser.rows()].index(name)
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
    def test_agents_are_listed_by_size_and_an_empty_one_is_hidden(self):
        names = [agent.name for agent in self.library().root.visible()]

        self.assertEqual(names, ["claude", "codex"])

    def test_an_agent_that_is_not_installed_is_skipped(self):
        shutil.rmtree(self.home / ".codex")

        self.assertEqual([agent.name for agent in self.library().root.visible()], ["claude"])

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
        for _ in range(10):
            browser.handle_key("down")
        self.assertEqual(browser.current().name, "codex")
        browser.handle_key("home")
        self.assertEqual(browser.current().name, "claude")
        browser.handle_key("end")
        self.assertEqual(browser.current().name, "codex")

    def test_a_file_cannot_be_opened(self):
        browser = self.browser()
        for key in ("right", "down", "right", "right"):
            browser.handle_key(key)

        self.assertEqual(len(browser.stack), 3)

        browser.handle_key("right")
        self.assertEqual(len(browser.stack), 3)
        self.assertIn("Nothing to open", browser.message)

    def test_nothing_with_no_size_is_ever_listed(self):
        browser = self.browser()
        seen = []
        stack = [browser.library.root]
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
        self.assertGreater(browser.offsets[-1], 0)

    def test_a_small_terminal_gets_a_message_not_a_broken_screen(self):
        screen = lines_of(self.browser(), 40, 8)

        self.assertEqual(len(screen), 1)
        self.assertIn("Terminal too small", screen[0])

    def test_nothing_found_says_so(self):
        shutil.rmtree(self.home / ".claude")
        shutil.rmtree(self.home / ".codex")

        screen = "\n".join(lines_of(self.browser()))

        self.assertIn("No agent folders with data found", screen)


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
        self.assertEqual([agent.name for agent in browser.rows()], ["claude", "codex"])

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
        entry = ca.scan(str(outside), ca.CACHE, "claude", set())

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
        self.assertNotIn("gemini", result.stdout)
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
        self.assertIn("Nothing found", result.stdout)

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
        self.assertIn("Claude Code, Codex and Gemini", lines[2])


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
