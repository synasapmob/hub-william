"""Exercise the memory tool against temporary home folders, never the real one."""

import importlib.util
import os
from pathlib import Path
import re
import select
import shutil
import sqlite3
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
SCRIPT = REPOSITORY / "contributors" / "synasapmob" / "tools" / "memory" / "memory.py"

spec = importlib.util.spec_from_file_location("memory_tool", SCRIPT)
mem = importlib.util.module_from_spec(spec)
# The tool's folder is published as it is: a __pycache__ left beside the script would be
# bundled into the catalogue, so importing it here must not write bytecode.
write_bytecode = sys.dont_write_bytecode
sys.dont_write_bytecode = True
try:
    spec.loader.exec_module(mem)
finally:
    sys.dont_write_bytecode = write_bytecode

RULES_TEXT = "# Shared rules\n\n- Never save memory on your own.\n"
INDEX_TEXT = "- [Helpers](feedback_helpers.md) - never call useEffect in utils helpers\n"
MEMORY_TEXT = (
    "---\nname: feedback-helpers\ndescription: never call useEffect in helpers\n---\n\n"
    "Hooks only work inside components.\n"
)


def write(path, text="made-up text\n"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def encode(path):
    """How Claude names a project's folder: "/" and "." both become "-"."""
    return str(path).replace("/", "-").replace(".", "-")


def make_database(path, rows, table="stage1_outputs"):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(path))
    if table == "stage1_outputs":
        connection.execute(
            "CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL,"
            " raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, rollout_slug TEXT,"
            " generated_at INTEGER NOT NULL, usage_count INTEGER, last_usage INTEGER,"
            " selected_for_phase2 INTEGER NOT NULL DEFAULT 0, selected_for_phase2_source_updated_at INTEGER)"
        )
        for thread, slug, summary, raw, generated in rows:
            connection.execute(
                "INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary,"
                " rollout_slug, generated_at) VALUES (?, 0, ?, ?, ?, ?)",
                (thread, raw, summary, slug, generated),
            )
    else:
        connection.execute("CREATE TABLE %s (x TEXT)" % table)
    connection.commit()
    connection.close()


def go(browser, *names):
    """Open each named row in turn, whatever order the sizes put them in."""
    for name in names:
        browser.select([row.name for row in browser.rows()].index(name))
        browser.handle_key("right")


def lines_of(browser, width=100, height=30):
    return ["".join(text for text, _ in spans) for spans in browser.render(width, height)]


def entry_at(library, *names):
    entry = library.root
    for name in names:
        entry = next(child for child in entry.children if child.name == name)
    return entry


class HomeTestCase(unittest.TestCase):
    """A home folder with what the agents keep: learned memory, a Codex database and, which the tool must leave out, rules."""

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
        shared = write(self.home / ".agents" / "AGENTS.md", RULES_TEXT)
        for folder, name in ((".claude", "CLAUDE.md"), (".codex", "AGENTS.md"), (".gemini", "AGENTS.md")):
            (self.home / folder).mkdir(exist_ok=True)
            os.symlink(shared, self.home / folder / name)
        write(self.home / ".gemini" / "GEMINI.md", "# Gemini\n- Added: prefer short answers.\n")

        app = self.home / "code" / "app"
        write(app / "CLAUDE.md", "# app\n- use pnpm\n")
        memory = self.home / ".claude" / "projects" / encode(app) / "memory"
        write(memory / "MEMORY.md", INDEX_TEXT)
        write(memory / "feedback_helpers.md", MEMORY_TEXT)
        write(self.home / ".claude" / "projects" / "-gone-project" / "memory" / "note.md", "a lesson\n")
        (self.home / ".claude" / "projects" / "-empty" / "memory").mkdir(parents=True)

        write(self.home / ".codex" / "memories" / "one.md", "codex learned this\n")
        make_database(
            self.home / ".codex" / "memories_1.sqlite",
            [
                ("thread-aaaa1111", "fix-flaky-test", "Fixed a flaky test.", "raw: seed the clock", 1792000000),
                ("thread-bbbb2222", None, "Prefers pnpm.", "raw: always use pnpm", 1792000100),
            ],
        )

    def library(self):
        return mem.load(str(self.home))

    def browser(self, **options):
        return mem.Browser(self.library(), lambda: mem.load(str(self.home)), **options)

    def trashed(self):
        files, _ = mem.trash_locations(str(self.home))
        return sorted(os.listdir(files)) if os.path.isdir(files) else []


class FindingMemoryTest(HomeTestCase):
    def test_every_agent_is_listed_largest_first_with_its_type(self):
        agents = self.library().root.visible()

        self.assertEqual(sorted(agent.name for agent in agents), ["agy", "claude", "codex", "grok"])
        self.assertEqual([agent.size for agent in agents], sorted((a.size for a in agents), reverse=True))
        types = dict((agent.name, mem.entry_status(agent)) for agent in agents)
        self.assertEqual(types, {"claude": "memory", "codex": "memory", "agy": "empty", "grok": "empty"})

    def test_the_memory_tab_holds_no_instruction_files(self):
        library = self.library()
        stack = [library.root]
        kinds = set()
        while stack:
            node = stack.pop()
            if not node.is_dir:
                kinds.add(node.kind)
            stack.extend(node.visible())

        self.assertEqual(kinds, {mem.LEARNED})
        self.assertNotIn("Global", [child.name for child in entry_at(library, "claude").visible()])
        self.assertNotIn("CLAUDE.md", [c.name for c in entry_at(library, "claude", "~/code/app").visible()])
        self.assertEqual([child.name for child in entry_at(library, "codex").visible()].count("AGENTS.md"), 0)

    def test_claude_shows_the_projects_that_have_memory(self):
        claude = entry_at(self.library(), "claude")

        names = [child.name for child in claude.visible()]

        self.assertEqual(sorted(names), sorted(["~/code/app", "-gone-project"]))
        self.assertNotIn("-empty", names)

    def test_a_project_holds_its_memory_folder(self):
        project = entry_at(self.library(), "claude", "~/code/app")

        self.assertEqual([child.name for child in project.visible()], ["memory"])
        self.assertEqual([c.name for c in entry_at(self.library(), "claude", "~/code/app", "memory").visible()],
                         ["feedback_helpers.md", "MEMORY.md"])
        self.assertEqual(mem.entry_status(project), "memory")

    def test_paths_count_files_and_every_screen_adds_up(self):
        library = self.library()
        for agent in library.root.visible():
            self.assertEqual(agent.paths, sum(child.paths for child in agent.visible()), agent.name)
            self.assertEqual(agent.size, sum(child.size for child in agent.visible()), agent.name)
        self.assertEqual(entry_at(self.library(), "claude", "~/code/app", "memory").paths, 2)

    def test_no_folder_and_no_files_both_show_empty_but_the_messages_differ(self):
        shutil.rmtree(self.home / ".gemini")  # agy: no folder at all
        os.remove(self.home / ".codex" / "AGENTS.md")  # codex: a folder with nothing to show
        shutil.rmtree(self.home / ".codex" / "memories")
        os.remove(self.home / ".codex" / "memories_1.sqlite")
        browser = self.browser()
        types = dict((row.name, mem.entry_status(row)) for row in browser.rows())

        self.assertEqual(types["agy"], "empty")
        self.assertEqual(types["codex"], "empty")
        self.assertTrue(os.path.isdir(self.home / ".codex"))
        for name, text in (("agy", "agy has no folder here"), ("codex", "codex has no memory files yet")):
            browser.select([row.name for row in browser.rows()].index(name))
            browser.handle_key("right")
            self.assertIn(text, browser.message)
            self.assertEqual(len(browser.stack), 1)

    def test_a_missing_agent_is_listed_but_cannot_be_opened(self):
        shutil.rmtree(self.home / ".gemini")
        browser = self.browser()
        browser.select([row.name for row in browser.rows()].index("agy"))

        self.assertEqual(mem.entry_status(browser.current()), "empty")
        browser.handle_key("right")

        self.assertEqual(len(browser.stack), 1)
        self.assertIn("agy has no folder here", browser.message)

    def test_an_agent_with_a_folder_but_no_memory_is_empty(self):
        os.remove(self.home / ".gemini" / "AGENTS.md")
        os.remove(self.home / ".gemini" / "GEMINI.md")
        browser = self.browser()
        browser.select([row.name for row in browser.rows()].index("agy"))

        self.assertEqual(mem.entry_status(browser.current()), "empty")
        browser.handle_key("right")

        self.assertIn("agy has no memory files yet", browser.message)

    def test_nothing_with_no_size_is_listed_below_an_agent(self):
        write(self.home / ".claude" / "projects" / "-gone-project" / "memory" / "blank.md", "")
        stack = list(self.library().root.visible())
        seen = []
        while stack:
            node = stack.pop()
            for child in node.visible():
                seen.append(child)
                stack.append(child)

        self.assertTrue(seen)
        self.assertTrue(all(entry.size > 0 for entry in seen))
        self.assertNotIn("blank.md", [entry.name for entry in seen])

    def test_project_names_are_decoded_to_the_path_that_exists(self):
        folder = encode(self.home / "code" / "app")

        self.assertEqual(mem.project_label(folder, str(self.home)), "~/code/app")
        self.assertEqual(mem.project_label("-gone-project", str(self.home)), "-gone-project")
        (self.home / "code" / "hub-william").mkdir()
        self.assertEqual(
            mem.project_label(encode(self.home / "code" / "hub-william"), str(self.home)), "~/code/hub-william"
        )

    def test_a_dot_inside_a_folder_name_is_found(self):
        (self.home / "work" / "my.app").mkdir(parents=True)
        (self.home / "work" / "hub-william.site").mkdir()

        for name in ("my.app", "hub-william.site"):
            folder = encode(self.home / "work" / name)

            self.assertEqual(mem.find_project(folder), str(self.home / "work" / name), name)
            self.assertEqual(mem.project_label(folder, str(self.home)), "~/work/" + name)

    def test_a_folder_name_that_starts_with_a_dash_is_found(self):
        (self.home / "-odd" / "code" / "app").mkdir(parents=True)

        self.assertEqual(mem.find_project(encode(self.home / "-odd" / "code" / "app")), str(self.home / "-odd" / "code" / "app"))

    def test_a_path_that_does_not_exist_is_not_found(self):
        self.assertIsNone(mem.find_project(encode(self.home / "nowhere" / "app")))
        self.assertIsNone(mem.find_project("no-leading-dash"))

    def test_a_project_in_a_dotted_folder_shows_its_label_and_its_memory(self):
        app = self.home / "work" / "my.app"
        write(self.home / ".claude" / "projects" / encode(app) / "memory" / "note.md", "a lesson\n")
        app.mkdir(parents=True)

        memory = entry_at(self.library(), "claude", "~/work/my.app", "memory")

        self.assertEqual([child.name for child in memory.visible()], ["note.md"])

    def test_a_project_is_found_even_when_its_folder_is_a_dot_folder(self):
        (self.home / "code" / ".claude" / "worktrees" / "fix").mkdir(parents=True)

        label = mem.project_label(encode(self.home / "code" / ".claude" / "worktrees" / "fix"), str(self.home))

        self.assertEqual(label, "~/code/.claude/worktrees/fix")


class DatabaseTest(HomeTestCase):
    def test_each_memory_in_the_database_is_a_read_only_row(self):
        library = self.library()
        database = entry_at(library, "codex", "memories_1.sqlite")

        names = [row.name for row in database.visible()]

        self.assertEqual(sorted(names), ["fix-flaky-test", "thread-bbbb2"])
        self.assertEqual(database.paths, 2)
        self.assertTrue(all(not row.deletable for row in database.children))
        self.assertEqual(mem.prunable(database), [])

    def test_a_row_opens_in_the_viewer_with_its_summary_and_text(self):
        browser = self.browser()

        go(browser, "codex", "memories_1.sqlite", "fix-flaky-test")

        screen = "\n".join(lines_of(browser))
        self.assertIn("Fixed a flaky test.", screen)
        self.assertIn("raw: seed the clock", screen)

    def test_a_database_with_no_memories_is_not_listed(self):
        make_database(self.home / ".codex" / "memories_1.sqlite.new", [])
        os.replace(self.home / ".codex" / "memories_1.sqlite.new", self.home / ".codex" / "memories_1.sqlite")
        library = self.library()

        self.assertNotIn("memories_1.sqlite", [child.name for child in entry_at(library, "codex").visible()])
        self.assertEqual(mem.prunable(entry_at(library, "codex")), [entry_at(library, "codex", "memories")])
    def test_a_database_with_a_layout_we_do_not_know_is_not_read(self):
        os.remove(self.home / ".codex" / "memories_1.sqlite")
        make_database(self.home / ".codex" / "memories_1.sqlite", [], table="something_else")
        browser = self.browser()

        go(browser, "codex", "memories_1.sqlite")

        self.assertIn("layout this tool does not know", browser.message)

    def test_a_file_that_is_not_a_database_is_not_read(self):
        write(self.home / ".codex" / "memories_1.sqlite", "this is not a database " * 20)
        browser = self.browser()

        go(browser, "codex", "memories_1.sqlite")

        self.assertIn("layout this tool does not know", browser.message)

    def test_a_database_in_wal_mode_whose_side_files_are_gone_is_still_read(self):
        """Seen live: after Codex finished, the database had no -wal or -shm and a read-only open failed."""
        path = self.home / ".codex" / "memories_1.sqlite"
        connection = sqlite3.connect(str(path))
        connection.execute("PRAGMA journal_mode=WAL")
        connection.commit()
        connection.close()
        for side in ("-wal", "-shm"):
            if os.path.exists(str(path) + side):
                os.remove(str(path) + side)
        browser = self.browser()  # older SQLite cannot open this read-only; a newer one can

        go(browser, "codex", "memories_1.sqlite")

        self.assertEqual(sorted(row.name for row in browser.rows()), ["fix-flaky-test", "thread-bbbb2"])
        self.assertNotIn("layout", browser.message)

    def test_when_the_read_only_open_fails_the_database_is_opened_as_immutable(self):
        """Forces the failure seen live, whatever the SQLite version, and checks the fallback."""
        real = sqlite3.connect
        modes = []

        def connect(target, *args, **kwargs):
            modes.append(target.split("?")[1])
            if "mode=ro" in target:
                raise sqlite3.OperationalError("unable to open database file")
            return real(target, *args, **kwargs)

        with mock.patch.object(mem.sqlite3, "connect", connect):
            browser = self.browser()
            go(browser, "codex", "memories_1.sqlite")

        self.assertEqual(modes, ["mode=ro", "immutable=1"])
        self.assertEqual(sorted(row.name for row in browser.rows()), ["fix-flaky-test", "thread-bbbb2"])

    def test_an_error_that_is_not_about_opening_is_not_retried(self):
        real = sqlite3.connect
        modes = []

        def connect(target, *args, **kwargs):
            modes.append(target.split("?")[1])
            return real(target, *args, **kwargs)

        make_database(self.home / ".codex" / "memories_1.sqlite.other", [], table="something_else")
        os.replace(self.home / ".codex" / "memories_1.sqlite.other", self.home / ".codex" / "memories_1.sqlite")
        with mock.patch.object(mem.sqlite3, "connect", connect):
            browser = self.browser()
            go(browser, "codex", "memories_1.sqlite")

        self.assertEqual(modes, ["mode=ro"])
        self.assertIn("layout this tool does not know", browser.message)

    @unittest.skipIf(not hasattr(os, "geteuid") or os.geteuid() == 0, "root can open any file")
    def test_a_database_that_cannot_be_opened_says_so_not_that_the_layout_is_unknown(self):
        path = self.home / ".codex" / "memories_1.sqlite"
        path.chmod(0)
        self.addCleanup(path.chmod, 0o600)
        browser = self.browser()

        go(browser, "codex", "memories_1.sqlite")

        self.assertIn("could not be opened read-only", browser.message)
        self.assertNotIn("layout", browser.message)

    def test_git_internals_of_a_memory_folder_are_not_listed_or_counted(self):
        write(self.home / ".codex" / "memories" / ".git" / "objects" / "ab" / "cdef", "git object\n")
        write(self.home / ".codex" / "memories" / ".git" / "HEAD", "ref: refs/heads/main\n")
        write(self.home / ".codex" / "memories" / "raw_memories.md", "# memories\n")
        library = self.library()
        folder = entry_at(library, "codex", "memories")

        self.assertEqual(sorted(child.name for child in folder.visible()), ["one.md", "raw_memories.md"])
        self.assertEqual(folder.paths, 2)

    def test_deleting_the_memory_folder_moves_the_git_repository_with_it(self):
        write(self.home / ".codex" / "memories" / ".git" / "HEAD", "ref: refs/heads/main\n")
        browser = self.browser()
        browser.select([row.name for row in browser.rows()].index("codex"))

        browser.handle_key("d")
        browser.handle_key("y")

        self.assertFalse((self.home / ".codex" / "memories").exists())
        files, _ = mem.trash_locations(str(self.home))
        self.assertTrue(any(Path(files, name, ".git", "HEAD").exists() for name in os.listdir(files)))

    def test_the_database_is_opened_read_only_and_left_unchanged(self):
        path = self.home / ".codex" / "memories_1.sqlite"
        before = path.read_bytes()

        browser = self.browser()
        go(browser, "codex", "memories_1.sqlite", "fix-flaky-test")
        browser.handle_key("left")
        browser.handle_key("d")

        self.assertEqual(path.read_bytes(), before)


class GrokTest(HomeTestCase):
    """Grok keeps a global scope and one scope per workspace: topics, observations and a generated index."""

    def setUp(self):
        super().setUp()
        memory = self.home / ".grok" / "memory-v2"
        write(memory / "global" / "MEMORY.md", "# Global memory index\n\n- **Placeholder word** (`topics/placeholder-word.md`)\n")
        write(memory / "global" / "topics" / "placeholder-word.md", "# Placeholder word\n\nThe placeholder word is abc-memory-test.\n")
        write(memory / "global" / "observations" / "_inbox" / "obs-1.md", "- prefers short answers\n")
        write(memory / "global" / "index.sqlite", "search index " * 20)
        write(memory / "global" / "memory_state.sqlite", "state " * 50)
        write(memory / "global" / "archive" / "old.md", "archived\n")
        workspace = memory / "workspaces" / "atlas-web-1a2b3c4d"
        write(workspace / "MEMORY.md", "# Workspace memory index\n")
        write(workspace / "topics" / "conventions.md", "Use pnpm.\n")
        write(workspace / "index.sqlite", "x" * 100)
        (memory / "workspaces" / "empty-9f8e7d6c" / "topics").mkdir(parents=True)

    def names(self, *path):
        return sorted(child.name for child in entry_at(self.library(), *path).visible())

    def test_grok_shows_global_and_each_workspace_with_the_hash_removed(self):
        self.assertEqual(self.names("grok"), ["Global", "atlas-web"])
        self.assertEqual(mem.entry_status(entry_at(self.library(), "grok")), "memory")

    def test_global_holds_the_index_the_topics_and_the_observations(self):
        library = self.library()

        self.assertEqual(self.names("grok", "Global"), ["MEMORY.md", "observations", "topics"])
        types = dict((c.name, mem.entry_status(c)) for c in entry_at(library, "grok", "Global").visible())
        self.assertEqual(types, {"MEMORY.md": "memory", "observations": "memory", "topics": "memory"})
        self.assertEqual(self.names("grok", "Global", "observations"), ["_inbox"])

    def test_the_state_files_and_the_archive_are_never_listed(self):
        for path in (("grok", "Global"), ("grok", "atlas-web")):
            for name in self.names(*path):
                self.assertNotIn("sqlite", name)
                self.assertNotEqual(name, "archive")

    def test_a_workspace_with_nothing_in_it_is_not_listed(self):
        self.assertNotIn("empty", " ".join(self.names("grok")))

    def test_a_topic_can_be_read(self):
        browser = self.browser()

        go(browser, "grok", "Global", "topics", "placeholder-word.md")

        self.assertIn("The placeholder word is abc-memory-test.", "\n".join(lines_of(browser)))

    def test_the_generated_index_cannot_be_deleted(self):
        browser = self.browser()
        go(browser, "grok", "Global")
        browser.select([row.name for row in browser.rows()].index("MEMORY.md"))

        browser.handle_key("d")

        self.assertIsNone(browser.dialog)
        self.assertIn("read-only", browser.message)
        self.assertTrue((self.home / ".grok" / "memory-v2" / "global" / "MEMORY.md").exists())

    def test_d_on_global_moves_the_topics_and_observations_and_nothing_else(self):
        browser = self.browser()
        go(browser, "grok")
        browser.select([row.name for row in browser.rows()].index("Global"))

        browser.handle_key("d")
        self.assertEqual(sorted(item.name for item in browser.dialog.plan.items), ["observations", "topics"])
        browser.handle_key("y")

        root = self.home / ".grok" / "memory-v2" / "global"
        self.assertFalse((root / "topics").exists())
        self.assertFalse((root / "observations").exists())
        for kept in (root / "MEMORY.md", root / "index.sqlite", root / "memory_state.sqlite",
                     root / "archive" / "old.md"):
            self.assertTrue(kept.exists(), kept)
        self.assertEqual(len(self.trashed()), 2)
        self.assertTrue(all(name.startswith("grok-global-") for name in self.trashed()), self.trashed())

    def test_d_on_a_workspace_moves_only_its_topics(self):
        browser = self.browser()
        go(browser, "grok")
        browser.select([row.name for row in browser.rows()].index("atlas-web"))

        browser.handle_key("d")
        browser.handle_key("y")

        workspace = self.home / ".grok" / "memory-v2" / "workspaces" / "atlas-web-1a2b3c4d"
        self.assertFalse((workspace / "topics").exists())
        self.assertTrue((workspace / "MEMORY.md").exists())
        self.assertTrue((self.home / ".grok" / "memory-v2" / "global" / "topics" / "placeholder-word.md").exists())

    def test_one_topic_can_be_moved_alone(self):
        browser = self.browser()
        go(browser, "grok", "Global", "topics")
        browser.select(0)

        browser.handle_key("d")
        self.assertEqual([item.name for item in browser.dialog.plan.items], ["placeholder-word.md"])
        browser.handle_key("y")

        self.assertFalse((self.home / ".grok" / "memory-v2" / "global" / "topics" / "placeholder-word.md").exists())
        self.assertTrue((self.home / ".grok" / "memory-v2" / "global" / "observations" / "_inbox" / "obs-1.md").exists())

    def test_a_scope_that_holds_only_the_generated_index_is_not_listed(self):
        """Seen live: a workspace with an empty topics folder and only Grok's index looked deletable."""
        memory = self.home / ".grok" / "memory-v2"
        shutil.rmtree(memory / "global")
        shutil.rmtree(memory / "workspaces" / "atlas-web-1a2b3c4d")
        write(memory / "workspaces" / "hub-william-3899205e" / "MEMORY.md", "# Workspace memory index\n")
        (memory / "workspaces" / "hub-william-3899205e" / "topics").mkdir()
        (memory / "workspaces" / "hub-william-3899205e" / "observations" / "_inbox").mkdir(parents=True)
        write(memory / "global" / "MEMORY.md", "# Global memory index\n")

        self.assertEqual(self.names("grok"), [])  # an index with no notes says nothing
        self.assertEqual(mem.entry_status(entry_at(self.library(), "grok")), "empty")

    def test_the_index_is_shown_again_as_soon_as_there_is_a_note(self):
        write(self.home / ".grok" / "memory-v2" / "workspaces" / "hub-william-3899205e" / "MEMORY.md", "# index\n")
        write(self.home / ".grok" / "memory-v2" / "workspaces" / "hub-william-3899205e" / "topics" / "a.md", "note\n")

        self.assertEqual(self.names("grok", "hub-william"), ["MEMORY.md", "topics"])

    def test_refusing_to_delete_names_what_is_read_only(self):
        browser = self.browser()
        go(browser, "codex")
        browser.select([row.name for row in browser.rows()].index("memories_1.sqlite"))

        browser.handle_key("d")

        self.assertIsNone(browser.dialog)
        self.assertIn("generated indexes and databases are read-only", browser.message)

    def test_a_workspace_label_loses_only_a_trailing_eight_digit_hash(self):
        self.assertEqual(mem.project_label("hub-william-3899205e", "/h", "hash"), "hub-william")
        self.assertEqual(mem.project_label("plain", "/h", "hash"), "plain")
        self.assertEqual(mem.project_label("abc-1234567", "/h", "hash"), "abc-1234567")
        self.assertEqual(mem.project_label("3899205e", "/h", "hash"), "3899205e")

    def test_grok_without_memory_folders_is_simply_empty(self):
        shutil.rmtree(self.home / ".grok" / "memory-v2")

        self.assertEqual(mem.entry_status(entry_at(self.library(), "grok")), "empty")


class TabsTest(HomeTestCase):
    def test_the_tabs_are_numbered_and_the_active_one_is_marked(self):
        browser = self.browser()
        self.assertIn("1 disk  [2 memory]", next(text for text in lines_of(browser) if "1 disk" in text))

        browser.handle_key("1")
        self.assertIn("[1 disk]  2 memory", next(text for text in lines_of(browser) if "1 disk" in text))

    def test_the_number_keys_and_tab_switch_tabs(self):
        browser = self.browser()

        self.assertEqual(browser.tab, 1)
        browser.handle_key("1")
        self.assertEqual(browser.tab, 0)
        browser.handle_key("2")
        self.assertEqual(browser.tab, 1)
        order = []
        for _ in range(3):
            browser.handle_key("tab")
            order.append(browser.tab)
        self.assertEqual(order, [0, 1, 0])

    def test_a_key_for_a_tab_that_does_not_exist_does_nothing(self):
        browser = self.browser()

        browser.handle_key("3")

        self.assertEqual(browser.tab, 1)
        self.assertIn("claude", "\n".join(lines_of(browser)))

    def test_the_memory_tab_keeps_its_place_when_you_look_at_the_disk_tab(self):
        browser = self.browser()
        go(browser, "claude", "~/code/app")
        browser.handle_key("1")
        browser.handle_key("2")

        self.assertEqual([entry.name for entry in browser.stack], ["memory", "claude", "~/code/app"])

    def test_a_new_run_starts_on_the_memory_tab_at_the_top(self):
        first = self.browser()
        go(first, "claude")
        second = self.browser()

        self.assertEqual((second.tab, len(second.stack), second.index()), (1, 1, 0))

    def test_the_memory_tab_shows_the_delete_hint_and_the_disk_tab_does_not(self):
        browser = self.browser()
        self.assertIn("[D] delete", "\n".join(lines_of(browser)))
        browser.handle_key("1")

        text = "\n".join(lines_of(browser))
        self.assertNotIn("[D] delete", text)
        self.assertIn("[2] memory", text)


class ScrollingPreviewTest(HomeTestCase):
    """A delete preview with more rows than the screen has: the arrows scroll it, and nothing else cancels it."""

    def many(self, count=20):
        for number in range(count):
            write(self.home / ".claude" / "projects" / ("-proj-%02d" % number) / "memory" / "note.md", "a lesson\n")

    def preview(self):
        browser = self.browser()
        browser.select([row.name for row in browser.rows()].index("claude"))
        browser.handle_key("d")
        return browser

    def shown(self, browser, height):
        return "\n".join(lines_of(browser, 100, height))

    def test_a_long_preview_scrolls_and_says_which_rows_are_shown(self):
        self.many()
        browser = self.preview()
        total = len(browser.dialog.plan.items)

        first = self.shown(browser, 20)
        browser.handle_key("down")
        second = self.shown(browser, 20)

        self.assertEqual(total, 22)
        self.assertRegex(first, r"rows 1-\d+ of %d" % total)
        self.assertIn("kept (read-only)", first)
        self.assertIn("[Esc] cancel  [q] quit", first)
        self.assertRegex(second, r"rows 2-\d+ of %d" % total)
        self.assertIsNotNone(browser.dialog)

    def test_every_row_can_be_reached_and_the_ends_wrap(self):
        self.many()
        browser = self.preview()
        total = len(browser.dialog.plan.items)
        seen = set()
        for _ in range(total + 2):
            seen.update(re.findall(r"-proj-\d\d", self.shown(browser, 20)))
            browser.handle_key("down")

        self.assertEqual(len(seen), 20)
        self.assertEqual(browser.dialog.top, (total + 2) % (browser.dialog.max_top + 1))
        browser.handle_key("home")
        self.shown(browser, 20)
        browser.handle_key("up")
        self.assertEqual(browser.dialog.top, browser.dialog.max_top)
        browser.handle_key("down")
        self.assertEqual(browser.dialog.top, 0)

    def test_pages_home_and_end_move_through_the_preview(self):
        self.many()
        browser = self.preview()
        self.shown(browser, 20)

        browser.handle_key("pagedown")
        self.assertEqual(browser.dialog.top, browser.dialog.page)
        browser.handle_key("end")
        self.assertRegex(self.shown(browser, 20), r"rows (\d+)-(\d+) of \2\b")
        browser.handle_key("pageup")
        self.assertLess(browser.dialog.top, browser.dialog.max_top)
        browser.handle_key("g")
        self.assertEqual(browser.dialog.top, 0)
        browser.handle_key("G")
        self.shown(browser, 20)
        self.assertEqual(browser.dialog.top, browser.dialog.max_top)

    def test_scrolling_never_cancels_and_y_moves_every_item_not_only_the_shown_ones(self):
        self.many()
        browser = self.preview()
        total = len(browser.dialog.plan.items)
        for key in ("down", "down", "pagedown", "end", "up", "j", "k"):
            browser.handle_key(key)
            self.shown(browser, 20)

            self.assertIsNotNone(browser.dialog, key)
        self.assertEqual(self.trashed(), [])

        browser.handle_key("y")

        self.assertIn("Moved", browser.message)
        self.assertEqual(len(self.trashed()), total)
        self.assertFalse((self.home / ".claude" / "projects" / "-proj-19" / "memory").exists())

    def test_the_scroll_position_stays_valid_when_the_terminal_grows(self):
        self.many()
        browser = self.preview()
        self.shown(browser, 16)
        browser.handle_key("end")
        self.shown(browser, 16)

        tall = self.shown(browser, 60)

        self.assertNotIn("rows ", tall)  # everything fits now
        self.assertEqual(browser.dialog.top, 0)
        self.assertIn("[↑↓] move", tall)

    def test_the_move_hint_is_there_even_when_nothing_scrolls(self):
        browser = self.preview()

        text = self.shown(browser, 30)

        self.assertNotIn("rows ", text)
        self.assertRegex(text, r"\[↑↓\] move\s+\[Esc\] cancel  \[q\] quit")

    def test_the_hints_in_ascii_mode_say_up_down(self):
        self.many()
        browser = self.browser(ascii_only=True)
        browser.select([row.name for row in browser.rows()].index("claude"))
        browser.handle_key("d")

        self.assertIn("[Up/Down] move", self.shown(browser, 20))

    def test_the_preview_never_gets_taller_than_the_terminal(self):
        self.many()
        browser = self.preview()

        for width, height in ((64, 12), (64, 14), (100, 20), (160, 50)):
            lines = browser.render(width, height)
            self.assertEqual({sum(len(t) for t, _ in spans) for spans in lines}, {width})
            self.assertLessEqual(len(lines), max(height, 13), (width, height))


class FormatTest(unittest.TestCase):
    def test_sizes(self):
        self.assertEqual(mem.format_size(0), "0 B")
        self.assertEqual(mem.format_size(900), "900 B")
        self.assertEqual(mem.format_size(272 * 1024), "272 KB")
        self.assertEqual(mem.format_size(int(5.94 * 1024 * 1024)), "5.9 MB")
        self.assertEqual(mem.format_size(1023 * 1024), "1.0 MB")

    def test_ages(self):
        self.assertEqual(mem.format_age(5), "now")
        self.assertEqual(mem.format_age(-30), "now")
        self.assertEqual(mem.format_age(5 * 60), "5m")
        self.assertEqual(mem.format_age(3 * 3600), "3h")
        self.assertEqual(mem.format_age(41 * 86400), "41d")
        self.assertEqual(mem.format_age(800 * 86400), "2y")

    def test_fit_pads_or_keeps_the_end(self):
        self.assertEqual(mem.fit("ab", 5, mem.UNICODE_CHARS), "ab   ")
        self.assertEqual(mem.fit("abcdefgh", 5, mem.UNICODE_CHARS), "abcd…")
        self.assertEqual(mem.fit("abcdefgh", 5, mem.UNICODE_CHARS, tail=True), "…efgh")
        self.assertEqual(len(mem.fit("abcdefgh", 5, mem.ASCII_CHARS, tail=True)), 5)


class KeysTest(unittest.TestCase):
    def test_arrows_with_ctrl_alt_or_cmd_jump_to_the_top_or_end(self):
        expected = (
            ("[1;9A", "home"), ("[1;9B", "end"), ("[1;5A", "home"), ("[1;5B", "end"),
            ("[1;3A", "home"), ("[1;3B", "end"), ("[1;13A", "home"), ("[1;2A", "up"), ("[1;2B", "down"),
            ("[A", "up"), ("[B", "down"), ("OA", "up"), ("OB", "down"), ("[C", "right"), ("[D", "left"),
            ("[H", "home"), ("[F", "end"), ("[1;5H", "home"), ("[1;9F", "end"),
            ("[1~", "home"), ("[4~", "end"), ("[7~", "home"), ("[8~", "end"),
            ("[5~", "pageup"), ("[6~", "pagedown"),
        )
        for sequence, key in expected:
            self.assertEqual(mem.parse_escape(sequence), key, sequence)

    def test_unknown_sequences_are_swallowed(self):
        for sequence in ("[99;99Z", "b", "[200~", "x1", "", "[<0;1;1M", "[1;9Q"):
            self.assertIsNone(mem.parse_escape(sequence), sequence)


class BrowsingTest(HomeTestCase):
    def test_right_opens_and_left_goes_back_to_the_same_row(self):
        browser = self.browser()
        browser.handle_key("down")
        name = browser.current().name
        browser.handle_key("right")

        self.assertEqual([entry.name for entry in browser.stack], ["memory", name])
        browser.handle_key("left")

        self.assertEqual(len(browser.stack), 1)
        self.assertEqual(browser.current().name, name)

    def test_the_cursor_goes_round_at_both_ends(self):
        browser = self.browser()
        names = [row.name for row in browser.rows()]

        browser.handle_key("up")
        self.assertEqual(browser.current().name, names[-1])
        browser.handle_key("down")
        self.assertEqual(browser.current().name, names[0])
        for _ in range(len(names)):
            browser.handle_key("down")
        self.assertEqual(browser.current().name, names[0])
        browser.handle_key("k")
        self.assertEqual(browser.current().name, names[-1])

    def test_home_end_and_pages_stop_at_the_ends(self):
        browser = self.browser()
        names = [row.name for row in browser.rows()]

        browser.handle_key("end")
        browser.handle_key("pagedown")
        self.assertEqual(browser.current().name, names[-1])
        browser.handle_key("home")
        browser.handle_key("pageup")
        self.assertEqual(browser.current().name, names[0])

    def test_a_folder_remembers_its_cursor_while_the_tool_runs(self):
        browser = self.browser()
        go(browser, "claude", "~/code/app", "memory")
        browser.handle_key("down")
        inside = browser.current().name
        browser.handle_key("left")
        self.assertEqual(browser.current().name, "memory")
        browser.handle_key("right")

        self.assertEqual(browser.current().name, inside)
        self.assertEqual(len(self.browser().stack), 1)  # a new run starts at the top
        self.assertEqual(self.browser().index(), 0)

    def test_the_position_survives_a_rescan(self):
        browser = self.browser()
        go(browser, "claude", "~/code/app", "memory")
        browser.handle_key("down")
        name = browser.current().name

        browser.handle_key("r")

        self.assertEqual(browser.current().name, name)
        self.assertEqual([entry.name for entry in browser.stack], ["memory", "claude", "~/code/app", "memory"])

    def test_the_disk_tab_is_a_placeholder(self):
        browser = self.browser()
        browser.handle_key("1")
        self.assertIn("not available yet", "\n".join(lines_of(browser)))
        browser.handle_key("d")
        self.assertIsNone(browser.dialog)
        browser.handle_key("2")
        self.assertIn("claude", "\n".join(lines_of(browser)))

    def test_q_quits(self):
        browser = self.browser()
        browser.handle_key("q")

        self.assertFalse(browser.running)


class RenderingTest(HomeTestCase):
    def test_every_line_is_exactly_the_screen_wide_and_high(self):
        for ascii_only in (False, True):
            browser = self.browser(ascii_only=ascii_only)
            for width, height in ((64, 12), (100, 30), (160, 50)):
                lines = browser.render(width, height)
                self.assertEqual({sum(len(t) for t, _ in spans) for spans in lines}, {width})
                self.assertEqual(len(lines), height)
            browser.handle_key("d")
            self.assertEqual({sum(len(t) for t, _ in s) for s in browser.render(100, 30)}, {100})

    def test_the_first_screen_shows_the_columns(self):
        screen = "\n".join(lines_of(self.browser()))

        for text in ("NAME", "PATHS", "SIZE", "AGE", "TYPE", "claude", "codex", "[2 memory]", "[D] delete"):
            self.assertIn(text, screen)

    def test_the_hints_are_spread_across_the_line_and_short(self):
        line = next(text for text in lines_of(self.browser(), 100, 30) if "[D] delete" in text)

        self.assertTrue(line.startswith("│ [↑↓] move  [→] open  [D] delete "), line)
        self.assertRegex(line, r"\[D\] delete\s{3,}\[r\] rescan  \[q\] quit │$")
        for text in ("delete cache", "nothing to delete", "MB)"):
            self.assertNotIn(text, line)

    def test_the_breadcrumb_names_where_you_are(self):
        browser = self.browser()
        go(browser, "claude", "~/code/app")

        self.assertIn("memory › claude › ~/code/app", "\n".join(lines_of(browser)))

    def test_a_long_list_scrolls_with_the_cursor(self):
        for number in range(40):
            write(self.home / ".codex" / "memories" / ("lesson-%02d.md" % number), "x" * (30 + number))
        browser = self.browser()
        go(browser, "codex", "memories")
        for _ in range(30):
            browser.handle_key("down")

        screen = lines_of(browser, 100, 20)
        marked = [line for line in screen if line.startswith("│ > ")]

        self.assertEqual(len(screen), 20)
        self.assertEqual(len(marked), 1)
        self.assertIn(browser.current().name, marked[0])
        self.assertGreater(browser.scroll[browser.key()], 0)

    def test_a_small_terminal_gets_a_message(self):
        screen = lines_of(self.browser(), 40, 8)

        self.assertEqual(len(screen), 1)
        self.assertIn("Terminal too small", screen[0])

    def test_a_home_with_no_agents_lists_them_all_as_empty(self):
        for name in (".claude", ".codex", ".gemini", ".agents"):
            shutil.rmtree(self.home / name)

        screen = "\n".join(lines_of(self.browser()))

        for name in ("claude", "codex", "agy", "grok"):
            self.assertRegex(screen, name + r"\s+-\s+-\s+-\s+empty")


class DeletingTest(HomeTestCase):
    def go_to(self, *names):
        browser = self.browser()
        if len(names) > 1:
            go(browser, *names[:-1])
        browser.select([row.name for row in browser.rows()].index(names[-1]))
        return browser

    def test_d_on_an_agent_moves_only_that_agents_learned_memory(self):
        browser = self.go_to("claude")

        browser.handle_key("D")

        self.assertEqual(browser.dialog.plan.title, 'Delete learned memory of "claude"')
        preview = "\n".join(lines_of(browser, 100, 30))
        for text in ("will move to the Trash", "kept (read-only)", "[y/N]", "Quit any agent"):
            self.assertIn(text, preview)
        self.assertNotIn("codex", preview)
        self.assertEqual(self.trashed(), [])

        browser.handle_key("y")

        self.assertIn("Moved", browser.message)
        projects = self.home / ".claude" / "projects"
        self.assertFalse((projects / encode(self.home / "code" / "app") / "memory").exists())
        self.assertFalse((projects / "-gone-project" / "memory").exists())
        self.assertTrue((projects / "-empty" / "memory").exists())
        self.assertTrue((self.home / "code" / "app" / "CLAUDE.md").exists())
        self.assertTrue((self.home / ".agents" / "AGENTS.md").exists())
        self.assertTrue((self.home / ".codex" / "memories" / "one.md").exists())
        self.assertEqual(len(self.trashed()), 2)
        self.assertTrue(all(name.startswith("claude-") and "memory" in name for name in self.trashed()), self.trashed())

    def test_d_on_one_project_moves_only_its_memory_folder(self):
        browser = self.go_to("claude", "-gone-project")

        browser.handle_key("d")
        browser.handle_key("y")

        projects = self.home / ".claude" / "projects"
        self.assertFalse((projects / "-gone-project" / "memory").exists())
        self.assertTrue((projects / encode(self.home / "code" / "app") / "memory" / "MEMORY.md").exists())

    def test_d_on_one_memory_file_moves_just_that_file(self):
        browser = self.go_to("claude", "~/code/app", "memory", "feedback_helpers.md")

        browser.handle_key("d")
        self.assertEqual([item.name for item in browser.dialog.plan.items], ["feedback_helpers.md"])
        self.assertIn("feedback_helpers.md", "\n".join(lines_of(browser)))
        browser.handle_key("y")

        memory = self.home / ".claude" / "projects" / encode(self.home / "code" / "app") / "memory"
        self.assertFalse((memory / "feedback_helpers.md").exists())
        self.assertTrue((memory / "MEMORY.md").exists())
        self.assertEqual(browser.stack[-1].name, "memory")

    def test_d_on_codex_moves_its_memories_folder_and_leaves_the_database_and_rules(self):
        browser = self.go_to("codex")

        browser.handle_key("d")
        browser.handle_key("y")

        self.assertFalse((self.home / ".codex" / "memories").exists())
        self.assertTrue((self.home / ".codex" / "memories_1.sqlite").exists())
        self.assertTrue((self.home / ".codex" / "AGENTS.md").is_symlink())
        self.assertEqual(self.trashed(), ["codex-codex-memories"])

    def test_a_database_cannot_be_deleted(self):
        browser = self.go_to("codex", "memories_1.sqlite")

        browser.handle_key("d")

        self.assertIsNone(browser.dialog)
        self.assertIn("read-only", browser.message)
        self.assertTrue((self.home / ".codex" / "memories_1.sqlite").exists())
        self.assertEqual(self.trashed(), [])

    def test_an_agent_with_no_memory_has_nothing_to_delete(self):
        browser = self.go_to("agy")

        browser.handle_key("d")

        self.assertIsNone(browser.dialog)
        self.assertIn("agy has no memory files yet: nothing to delete.", browser.message)

    def test_a_row_of_a_database_cannot_be_deleted(self):
        browser = self.go_to("codex", "memories_1.sqlite", "fix-flaky-test")

        browser.handle_key("d")

        self.assertIsNone(browser.dialog)
        self.assertIn("read-only", browser.message)

    def test_a_missing_agent_has_nothing_to_delete(self):
        shutil.rmtree(self.home / ".gemini")
        browser = self.go_to("agy")

        browser.handle_key("d")

        self.assertIsNone(browser.dialog)
        self.assertIn("agy has no folder here: nothing to delete.", browser.message)

    def test_n_enter_and_esc_cancel(self):
        for key in ("n", "N", "enter", "esc"):
            browser = self.go_to("claude")
            browser.handle_key("d")
            browser.handle_key(key)

            self.assertIsNone(browser.dialog, key)
            self.assertIn("Cancelled", browser.message, key)
            self.assertTrue(browser.running)
        self.assertTrue((self.home / ".claude" / "projects" / "-gone-project" / "memory").exists())

    def test_other_keys_are_ignored_and_the_question_stays_open(self):
        browser = self.go_to("claude")
        browser.handle_key("d")

        for key in ("x", " ", "a", "left", "right", "r", "1", "3", "tab", "d"):
            browser.handle_key(key)

            self.assertIsNotNone(browser.dialog, key)
        self.assertEqual((browser.tab, len(browser.stack)), (1, 1))
        self.assertEqual(self.trashed(), [])

    def test_q_quits_without_moving_anything(self):
        browser = self.go_to("claude")
        browser.handle_key("d")

        browser.handle_key("q")

        self.assertFalse(browser.running)
        self.assertIsNone(browser.dialog)
        self.assertEqual(self.trashed(), [])
        self.assertTrue((self.home / ".claude" / "projects" / "-gone-project" / "memory").exists())

    def test_the_question_has_a_line_and_the_few_hints_sit_at_both_edges_below_it(self):
        browser = self.go_to("claude")
        browser.handle_key("d")

        lines = lines_of(browser)
        question = next(i for i, text in enumerate(lines) if "Move to the Trash?" in text)

        self.assertRegex(lines[question], r"^│ Move to the Trash\?  \[y/N\]\s*│$")
        self.assertNotIn("cancel", lines[question])
        self.assertRegex(lines[question + 1], r"^│ \[↑↓\] move\s{3,}\[Esc\] cancel  \[q\] quit │$")  # even with nothing to scroll
        self.assertEqual(sum("[Esc] cancel" in text for text in lines), 1)
        self.assertTrue(lines[-1].startswith("└"))

    def test_the_screen_is_rebuilt_and_the_cursor_stays_nearby_after_deleting(self):
        browser = self.go_to("claude")
        before = browser.library.root.size

        browser.handle_key("d")
        browser.handle_key("y")

        self.assertLess(browser.library.root.size, before)
        self.assertEqual(browser.current().name, "claude")

    def test_trash_names_never_collide(self):
        for _ in range(2):
            write(self.home / ".codex" / "memories" / "again.md", "again\n")
            browser = self.go_to("codex")
            browser.handle_key("d")
            browser.handle_key("y")

        self.assertEqual(len([name for name in self.trashed() if name.startswith("codex-")]), 2)

    def test_a_trash_name_keeps_the_end_of_a_long_project_name(self):
        browser = self.go_to("claude")
        browser.handle_key("d")
        browser.handle_key("y")

        names = self.trashed()

        self.assertTrue(any(name.endswith("-home-code-app-memory") for name in names), names)
        self.assertTrue(all(len(name) <= len("claude-") + 60 + len("-memory") for name in names), names)

    def test_the_freedesktop_trash_gets_an_info_file(self):
        with mock.patch.object(mem.sys, "platform", "linux"):
            browser = self.go_to("codex")
            browser.handle_key("d")
            browser.handle_key("y")
            files, info = mem.trash_locations(str(self.home))

        self.assertEqual(files, str(self.home / ".local" / "share" / "Trash" / "files"))
        records = sorted(os.listdir(info))
        self.assertEqual(len(records), 1)
        text = (Path(info) / records[0]).read_text()
        self.assertTrue(text.startswith("[Trash Info]\nPath="))
        self.assertIn("DeletionDate=", text)
        self.assertIn(".codex/memories", text)

    def test_xdg_data_home_moves_the_freedesktop_trash(self):
        with mock.patch.object(mem.sys, "platform", "linux"):
            with mock.patch.dict(os.environ, {"XDG_DATA_HOME": str(self.home / "data")}):
                files, info = mem.trash_locations(str(self.home))

        self.assertEqual(files, str(self.home / "data" / "Trash" / "files"))
        self.assertEqual(info, str(self.home / "data" / "Trash" / "info"))

    def test_macos_uses_the_trash_folder_in_the_home(self):
        with mock.patch.object(mem.sys, "platform", "darwin"):
            self.assertEqual(mem.trash_locations(str(self.home)), (str(self.home / ".Trash"), None))


class GuardTest(HomeTestCase):
    def plan_for(self, library, *path):
        return mem.Plan("test", [entry_at(library, *path)], 0)

    def test_a_memory_folder_swapped_for_a_symlink_is_refused_and_its_target_survives(self):
        library = self.library()
        plan = self.plan_for(library, "claude", "-gone-project", "memory")
        precious = self.home / "precious"
        write(precious / "keep.txt")
        shutil.rmtree(self.home / ".claude" / "projects" / "-gone-project" / "memory")
        os.symlink(precious, self.home / ".claude" / "projects" / "-gone-project" / "memory")

        moved, failed = mem.run_plan(plan, library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["reached through a symlink"])
        self.assertTrue((precious / "keep.txt").exists())
        self.assertEqual(self.trashed(), [])

    def test_an_entry_that_is_not_marked_deletable_is_refused(self):
        library = self.library()
        entry = entry_at(library, "claude", "~/code/app", "memory", "MEMORY.md")
        entry.deletable = False

        moved, failed = mem.run_plan(mem.Plan("test", [entry], 0), library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["not learned memory"])
        self.assertTrue(os.path.exists(entry.path))
        self.assertEqual(self.trashed(), [])

    def test_a_file_that_is_not_in_the_memory_folder_is_refused(self):
        library = self.library()
        entry = entry_at(library, "claude", "~/code/app", "memory", "MEMORY.md")
        root = entry.root
        entry.path = os.path.join(root, "elsewhere.txt")
        write(entry.path, "not memory\n")

        moved, failed = mem.run_plan(mem.Plan("test", [entry], 0), library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["not learned memory"])
        self.assertTrue(Path(entry.path).exists())

    def test_a_path_outside_the_agent_folder_is_refused(self):
        library = self.library()
        outside = self.home / "outside"
        write(outside / "x.md")
        root = os.path.realpath(self.home / ".claude" / "projects" / "-gone-project")
        entry = mem.scan_memory(str(outside), "claude", root)

        moved, failed = mem.run_plan(mem.Plan("test", [entry], 0), library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["outside the agent folder"])
        self.assertTrue(outside.exists())

    def test_something_deleted_since_the_scan_is_reported_not_fatal(self):
        library = self.library()
        plan = mem.Plan("test", [entry_at(library, "claude", "-gone-project", "memory"),
                                 entry_at(library, "codex", "memories")], 0)
        shutil.rmtree(self.home / ".claude" / "projects" / "-gone-project" / "memory")

        moved, failed = mem.run_plan(plan, library)

        self.assertEqual([entry.name for entry in moved], ["memories"])
        self.assertEqual([reason for _, reason in failed], ["already gone"])

    def test_a_failed_move_is_never_turned_into_a_permanent_delete(self):
        library = self.library()
        plan = self.plan_for(library, "codex", "memories")

        with mock.patch.object(mem.shutil, "move", side_effect=PermissionError("denied")):
            moved, failed = mem.run_plan(plan, library)

        self.assertEqual(moved, [])
        self.assertEqual([reason for _, reason in failed], ["denied"])
        self.assertTrue((self.home / ".codex" / "memories" / "one.md").exists())


class ViewerTest(HomeTestCase):
    """Reading a file: text only, read-only, and careful with what it shows."""

    def setUp(self):
        super().setUp()
        self.docs = self.home / ".codex" / "memories" / "docs"
        self.put("note.txt", "\n".join("line %d" % number for number in range(1, 101)).encode())
        self.put("data.json", b'{"a": 1, "b": [1, 2, 3], "name": "x"}')
        self.put("log.jsonl", b'{"n": 1}\n{"n": 2, "tags": ["a"]}\nnot json\n')
        self.put("picture.png", b"\x89PNG\r\n\x1a\n" + b"\0" * 30000)
        self.put("image.dmg", b"\xff\xfe" * 12000)
        self.put("big.log", "".join("log line %06d\n" % number for number in range(30000)).encode())
        self.put("escape.txt", b"plain \x1b[31mred\x1b[0m bell\x07 end\n")
        self.put("long.txt", b"w" * 500 + b"\nshort\n")
        self.put("accents.txt", "é".encode() * 200000)
        self.put("api-token.txt", b"made-up text, not a real secret\n")

    def put(self, name, data):
        self.docs.mkdir(parents=True, exist_ok=True)
        (self.docs / name).write_bytes(data)

    def open_file(self, name):
        browser = self.browser()
        go(browser, "codex", "memories", "docs", name)
        return browser

    def screen(self, browser, width=100, height=20):
        return "\n".join(lines_of(browser, width, height))

    def test_a_text_file_opens_and_scrolls(self):
        browser = self.open_file("note.txt")

        self.assertIsNotNone(browser.viewer)
        self.assertRegex(self.screen(browser), r"│\s+1 line 1\s+│")
        for _ in range(3):
            browser.handle_key("down")
        self.assertRegex(self.screen(browser), r"│\s+4 line 4\s+│")
        browser.handle_key("end")
        self.assertIn("line 100", self.screen(browser))
        browser.handle_key("home")
        self.assertRegex(self.screen(browser), r"│\s+1 line 1\s+│")
        browser.handle_key("pagedown")
        self.assertNotIn("line 1 ", self.screen(browser))

    def test_scrolling_goes_round_at_both_ends(self):
        browser = self.open_file("note.txt")
        self.screen(browser)

        browser.handle_key("up")
        self.assertIn("line 100", self.screen(browser))
        browser.handle_key("down")
        self.assertRegex(self.screen(browser), r"│\s+1 line 1\s+│")
        browser.handle_key("end")
        browser.handle_key("down")
        self.assertRegex(self.screen(browser), r"│\s+1 line 1\s+│")

    def test_a_file_that_fits_the_screen_does_not_move(self):
        browser = self.open_file("data.json")
        before = self.screen(browser, 100, 40)

        for key in ("down", "up", "down", "end", "home"):
            browser.handle_key(key)

        self.assertEqual(self.screen(browser, 100, 40), before)

    def test_the_viewer_hints_are_move_and_back_then_quit_at_the_far_edge(self):
        browser = self.open_file("data.json")

        line = next(text for text in lines_of(browser) if "[q] quit" in text)

        self.assertRegex(line, r"^│ \[↑↓\] move  \[←\] back\s+\[q\] quit │$")
        for word in ("PgUp", "pretty", "top/end", "scroll"):
            self.assertNotIn(word, self.screen(browser))

    def test_keys_without_a_hint_still_work(self):
        browser = self.open_file("note.txt")

        browser.handle_key("G")
        self.assertIn("line 100", self.screen(browser))
        browser.handle_key("g")
        self.assertRegex(self.screen(browser), r"│\s+1 line 1\s+│")
        browser.handle_key(" ")
        self.assertNotRegex(self.screen(browser), r"│\s+1 line 1\s+│")
        browser.handle_key("q")
        self.assertFalse(browser.running)

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
        browser.handle_key("p")

        pretty = self.screen(browser, 100, 30)
        self.assertIn('"n": 2,', pretty)
        self.assertIn("not json", pretty)

    def test_p_on_plain_text_says_it_cannot(self):
        browser = self.open_file("note.txt")

        browser.handle_key("p")

        self.assertIn("Only .json and .jsonl", self.screen(browser))

    def test_files_that_are_not_text_are_not_opened(self):
        for name in ("picture.png", "image.dmg"):
            browser = self.open_file(name)

            self.assertIsNone(browser.viewer, name)
            self.assertIn("is not readable text", browser.message, name)
            self.assertEqual(browser.current().name, name)

    def test_a_file_named_like_a_credential_opens_like_any_other(self):
        browser = self.open_file("api-token.txt")

        self.assertIsNotNone(browser.viewer)
        self.assertIn("made-up text, not a real secret", self.screen(browser))

    def test_only_the_start_of_a_big_file_is_read(self):
        browser = self.open_file("big.log")

        self.assertIn("first 256 KB of", self.screen(browser))
        browser.handle_key("end")
        self.assertNotIn("log line 029999", self.screen(browser))

    def test_a_character_cut_at_the_limit_does_not_hide_the_file(self):
        document = mem.read_document(str(self.docs / "accents.txt"))

        self.assertIsInstance(document, mem.Document)
        self.assertTrue(document.truncated)
        self.assertTrue(document.text.startswith("é"))

    def test_control_characters_never_reach_the_screen(self):
        screen = self.screen(self.open_file("escape.txt"))

        self.assertNotIn("\x1b", screen)
        self.assertNotIn("\x07", screen)
        self.assertIn("red", screen)

    def test_a_long_line_wraps_inside_the_screen(self):
        rows = self.open_file("long.txt").viewer.wrapped(80 - 2 - 8)

        self.assertEqual(rows[0][0], 1)
        self.assertIsNone(rows[1][0])
        self.assertTrue(all(len(text) <= 70 for _, text in rows))
        self.assertIn(2, [number for number, _ in rows])

    def test_every_viewer_line_is_exactly_the_screen_wide_and_as_high(self):
        for name in ("note.txt", "data.json"):
            for width, height in ((64, 12), (100, 30)):
                lines = self.open_file(name).render(width, height)
                self.assertEqual({sum(len(t) for t, _ in spans) for spans in lines}, {width}, (name, width))
                self.assertEqual(len(lines), height, (name, width, height))
                self.assertTrue(lines[-1][0][0].startswith("└"))

    def test_the_viewer_cannot_delete_anything(self):
        browser = self.open_file("note.txt")
        before = (self.docs / "note.txt").read_bytes()

        browser.handle_key("D")

        self.assertIsNone(browser.dialog)
        self.assertIn("read-only", browser.message)
        self.assertEqual((self.docs / "note.txt").read_bytes(), before)

    def test_symlinks_and_pipes_are_not_read_directly(self):
        os.symlink(self.docs / "note.txt", self.docs / "link.txt")

        self.assertEqual(
            mem.read_document(str(self.docs / "link.txt")), "is a symlink, which is not followed"
        )
        if hasattr(os, "mkfifo"):
            os.mkfifo(self.docs / "pipe")
            self.assertEqual(mem.read_document(str(self.docs / "pipe")), "is not a regular file")


class CommandLineTest(HomeTestCase):
    def run_script(self, *args):
        environment = {key: value for key, value in os.environ.items() if key != "XDG_DATA_HOME"}
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), *args],
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_list_prints_the_table_and_changes_nothing(self):
        def snapshot():
            return sorted(str(path) for path in self.home.rglob("*") if "Library" not in path.parts)

        before = snapshot()

        result = self.run_script("--list", "--home", str(self.home))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"memory\s+total [\d.]+ (B|KB), \d+ paths")
        self.assertRegex(result.stdout, r"claude\s+\d+\s+[\d.]+ (B|KB)\s+now\s+memory")
        self.assertNotIn("AGENTS.md", result.stdout)  # instruction files are not memory
        self.assertEqual(snapshot(), before)

    def test_list_for_one_agent_shows_its_projects(self):
        result = self.run_script("--list", "--agent=claude", "--home", str(self.home))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("memory > claude", result.stdout)
        self.assertIn("~/code/app", result.stdout)
        self.assertNotIn("Global", result.stdout)

    def test_list_shows_the_memory_database(self):
        result = self.run_script("--list", "--agent=codex", "--home", str(self.home))

        self.assertRegex(result.stdout, r"memories_1\.sqlite\s+2\s+[\d.]+ KB\s+\S+\s+memory")

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
        self.assertEqual(result.stdout.count("empty"), 4)

    def test_the_tool_folder_holds_only_the_script(self):
        """The catalogue publishes every file in the folder, so no bytecode may sit beside it."""
        self.assertEqual(sorted(os.listdir(SCRIPT.parent)), ["memory.py"])
        self.assertFalse(os.access(SCRIPT, os.X_OK), "published scripts are not executable")

    def test_the_catalogue_can_read_the_script_header(self):
        lines = []
        for line in SCRIPT.read_text().split("\n"):
            if line.startswith("#!"):
                continue
            if not line.startswith("#"):
                break
            lines.append(re.sub(r"^#\s?", "", line))

        self.assertTrue(lines[0].startswith("memory: "))
        self.assertEqual(lines[1], "")
        self.assertIn("terminal browser", lines[2])


@unittest.skipIf(pty is None, "needs a pseudo-terminal")
class TerminalTest(HomeTestCase):
    """Drive the real curses screen through a pseudo-terminal."""

    def start(self, rows=30, columns=100):
        environment = {key: value for key, value in os.environ.items() if key != "XDG_DATA_HOME"}
        environment.update({"TERM": "xterm-256color", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
        pid, descriptor = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            os.execve(sys.executable, [sys.executable, "-B", str(SCRIPT), "--home", str(self.home)], environment)
        self.addCleanup(self.finish, pid, descriptor)
        self.output = b""
        return pid, descriptor

    def finish(self, pid, descriptor):
        for action in (lambda: os.close(descriptor), lambda: os.kill(pid, 9), lambda: os.waitpid(pid, 0)):
            try:
                action()
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

        self.assertTrue(self.read_until(descriptor, rb"\[D\] delete"), self.output[-400:])
        self.assertIn(b"2 memory", self.output)
        os.write(descriptor, b"q")

        self.assertEqual(self.wait_for_exit(pid, descriptor), 0)

    def test_d_on_an_agent_works_end_to_end_through_the_keyboard(self):
        shutil.rmtree(self.home / ".codex")  # so claude is the first row
        pid, descriptor = self.start()
        self.assertTrue(self.read_until(descriptor, rb"> +claude"), self.output[-400:])

        os.write(descriptor, b"d")
        self.assertTrue(self.read_until(descriptor, rb"Move to the Trash\?"), self.output[-400:])
        os.write(descriptor, b"y")

        self.assertTrue(self.read_until(descriptor, rb"Moved"), self.output[-400:])
        os.write(descriptor, b"q")
        self.assertEqual(self.wait_for_exit(pid, descriptor), 0)
        self.assertFalse((self.home / ".claude" / "projects" / "-gone-project" / "memory").exists())
        self.assertTrue((self.home / ".agents" / "AGENTS.md").exists())
        self.assertEqual(len(self.trashed()), 2)

    def test_jump_keys_work_and_an_unknown_sequence_is_swallowed(self):
        names = [agent.name for agent in self.library().root.visible()]
        pid, descriptor = self.start()
        self.assertTrue(self.read_until(descriptor, rb"\[D\] delete"), self.output[-400:])

        for sequence, row in (
            (b"\x1b[1;9B", names[-1]),  # Cmd+Down
            (b"\x1b[1;9A", names[0]),  # Cmd+Up
            (b"\x1b[1;5B", names[-1]),  # Ctrl+Down
            (b"\x1b[1;5A", names[0]),  # Ctrl+Up
        ):
            self.output = b""
            os.write(descriptor, sequence)
            self.assertTrue(self.read_until(descriptor, rb">[^a-z]{0,40}" + row.encode()), (sequence, self.output[-300:]))

        self.output = b""
        os.write(descriptor, b"\x1b[1;9Q")  # a key we do not know must not become Esc, [, 1 (the disk tab), ...
        time.sleep(0.4)
        os.write(descriptor, b"q")

        self.assertEqual(self.wait_for_exit(pid, descriptor), 0)
        self.assertNotIn(b"not available yet", self.output)

    def test_browsing_writes_nothing_to_the_home_folder(self):
        def snapshot():
            return sorted(str(path) for path in self.home.rglob("*") if "Library" not in path.parts)

        before = snapshot()
        pid, descriptor = self.start()
        self.assertTrue(self.read_until(descriptor, rb"\[D\] delete"), self.output[-400:])
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
            command = '%s -B - --home %s < "%s"' % (sys.executable, self.home, SCRIPT)
            os.execve("/bin/sh", ["/bin/sh", "-c", command], environment)
        self.addCleanup(self.finish, pid, descriptor)
        self.output = b""

        self.assertTrue(self.read_until(descriptor, rb"\[D\] delete"), self.output[-400:])
        os.write(descriptor, b"q")

        self.assertEqual(self.wait_for_exit(pid, descriptor), 0)


if __name__ == "__main__":
    unittest.main()
