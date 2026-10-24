"""Exercise the skills link scripts against a temporary home, never the real one."""

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


REPOSITORY = Path(__file__).resolve().parents[5]
CONTRIBUTOR = REPOSITORY / "contributors" / "synasapmob"
SKILLS = CONTRIBUTOR / "tools" / "skills"
LINK = CONTRIBUTOR / "tools" / "link-skills" / "link.sh"
UNLINK = CONTRIBUTOR / "tools" / "link-skills" / "unlink.sh"
SKILL_NAMES = sorted(path.parent.name for path in SKILLS.glob("*/SKILL.md"))

# The shared rules as they shipped before link.sh kept a record of what it installed.
LEGACY_RULES = """# Global agent rules

Rules that every agent follows in every session.

## Memory

- Never save memory on your own initiative. Do not write to `AGENTS.md`, to notes files,
  or to any memory store unless the task itself requires it.
- When you learn something worth keeping, do not save it. Add one short notice at the very
  end of your reply: what you learned, where you would save it, and ask whether to keep it.
- Save only after the user agrees. If they decline, drop it and do not propose it again.
"""


def run(script, home, *args, **env):
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in ("AGENTS_HOME", "HUB_WILLIAM_ORIGIN")
    }
    environment["HOME"] = str(home)
    environment.update({key: str(value) for key, value in env.items()})
    return subprocess.run(
        ["bash", str(script), *args],
        env=environment,
        capture_output=True,
        text=True,
    )


def write_zip(target):
    """Write the zip the catalogue publishes: repository-relative entries."""
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w") as archive:
        for path in sorted(SKILLS.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(REPOSITORY).as_posix())
    return target


class LinkSkillsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name) / "home"
        self.home.mkdir()
        self.agents = self.home / ".agents"

    def link(self, *args, **env):
        result = run(LINK, self.home, "--path", str(SKILLS), *args, **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_the_published_skills_are_the_ones_installed(self):
        self.assertEqual(
            SKILL_NAMES,
            [
                "frontend-convention",
                "linear-task-scope",
                "mock-data",
                "operator-cli",
                "scroll-world",
            ],
        )

    def test_installs_skills_and_rules_into_agents_home(self):
        self.link()

        for name in SKILL_NAMES:
            self.assertEqual(
                (self.agents / "skills" / name / "SKILL.md").read_text(),
                (SKILLS / name / "SKILL.md").read_text(),
            )
        self.assertEqual(
            (self.agents / "AGENTS.md").read_text(),
            (SKILLS / "rules" / "AGENTS.md").read_text(),
        )
        self.assertFalse((self.agents / "skills" / "rules").exists())

    def test_links_only_where_an_agent_does_not_read_agents_home(self):
        for folder in (".claude", ".codex", ".dsh"):
            (self.home / folder).mkdir()

        self.link()

        agents_rules = str(self.agents / "AGENTS.md")
        for name in SKILL_NAMES:
            # Claude Code ignores ~/.agents, so it gets its own skill links.
            link = self.home / ".claude" / "skills" / name
            self.assertEqual(os.readlink(link), str(self.agents / "skills" / name))
            # Codex and DSH read ~/.agents/skills, so linking would only repeat it.
            self.assertFalse((self.home / ".codex" / "skills" / name).exists())
            self.assertFalse((self.home / ".dsh" / "skills" / name).exists())
        self.assertEqual(os.readlink(self.home / ".claude" / "CLAUDE.md"), agents_rules)
        # Codex reads its rules from ~/.codex; DSH reads ~/.agents/AGENTS.md.
        self.assertEqual(os.readlink(self.home / ".codex" / "AGENTS.md"), agents_rules)
        self.assertFalse((self.home / ".dsh" / "AGENTS.md").exists())

    def test_agents_that_are_not_installed_get_no_folder(self):
        self.link()

        for folder in (".claude", ".codex", ".dsh", ".gemini"):
            self.assertFalse((self.home / folder).exists())

    def test_links_agy_into_its_own_global_folders(self):
        (self.home / ".gemini" / "config").mkdir(parents=True)

        self.link()

        for name in SKILL_NAMES:
            link = self.home / ".gemini" / "config" / "skills" / name
            self.assertEqual(os.readlink(link), str(self.agents / "skills" / name))
        self.assertEqual(
            os.readlink(self.home / ".gemini" / "AGENTS.md"),
            str(self.agents / "AGENTS.md"),
        )

    def test_running_twice_changes_nothing(self):
        self.link()
        self.link()

        self.assertFalse((self.agents / ".backups").exists())
        self.assertFalse((self.agents / "AGENTS.hub-william.md").exists())

    def test_a_changed_skill_is_backed_up_outside_the_skills_folder(self):
        self.link()
        (self.agents / "skills" / "mock-data" / "SKILL.md").write_text("mine")

        self.link()

        backups = list((self.agents / ".backups").glob("*/mock-data/SKILL.md"))
        self.assertEqual([path.read_text() for path in backups], ["mine"])
        self.assertEqual(
            (self.agents / "skills" / "mock-data" / "SKILL.md").read_text(),
            (SKILLS / "mock-data" / "SKILL.md").read_text(),
        )

    def test_your_own_skills_and_rules_are_never_overwritten(self):
        (self.agents / "skills" / "mine").mkdir(parents=True)
        (self.agents / "skills" / "mine" / "SKILL.md").write_text("mine")
        (self.agents / "AGENTS.md").write_text("my rules")

        self.link()

        self.assertEqual((self.agents / "skills" / "mine" / "SKILL.md").read_text(), "mine")
        self.assertEqual((self.agents / "AGENTS.md").read_text(), "my rules")
        self.assertEqual(
            (self.agents / "AGENTS.hub-william.md").read_text(),
            (SKILLS / "rules" / "AGENTS.md").read_text(),
        )

    def link_from(self, source, **env):
        result = run(LINK, self.home, "--path", str(source), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def skills_with_rules(self, rules):
        """A copy of the Skills folder whose shared rules read `rules`."""
        copy = Path(self.directory.name) / "older" / "skills"
        shutil.copytree(SKILLS, copy)
        (copy / "rules" / "AGENTS.md").write_text(rules)
        return copy

    def test_linking_again_updates_rules_you_have_not_edited(self):
        self.link_from(self.skills_with_rules("old rules\n"))
        self.assertEqual((self.agents / "AGENTS.md").read_text(), "old rules\n")

        result = self.link()

        self.assertEqual(
            (self.agents / "AGENTS.md").read_text(),
            (SKILLS / "rules" / "AGENTS.md").read_text(),
        )
        backups = list((self.agents / ".backups").glob("*/AGENTS.md"))
        self.assertEqual([path.read_text() for path in backups], ["old rules\n"])
        self.assertIn("updated " + str(self.agents / "AGENTS.md"), result.stdout)
        self.assertFalse((self.agents / "AGENTS.hub-william.md").exists())

    def test_rules_you_edited_after_installing_are_kept(self):
        self.link_from(self.skills_with_rules("old rules\n"))
        (self.agents / "AGENTS.md").write_text("old rules\nmine\n")

        self.link()

        self.assertEqual((self.agents / "AGENTS.md").read_text(), "old rules\nmine\n")
        self.assertEqual(
            (self.agents / "AGENTS.hub-william.md").read_text(),
            (SKILLS / "rules" / "AGENTS.md").read_text(),
        )
        self.assertFalse((self.agents / ".backups").exists())

    def test_rules_from_before_the_record_existed_are_updated(self):
        self.agents.mkdir()
        (self.agents / "AGENTS.md").write_text(LEGACY_RULES)

        self.link()

        self.assertEqual(
            (self.agents / "AGENTS.md").read_text(),
            (SKILLS / "rules" / "AGENTS.md").read_text(),
        )
        backups = list((self.agents / ".backups").glob("*/AGENTS.md"))
        self.assertEqual([path.read_text() for path in backups], [LEGACY_RULES])

    def test_the_legacy_hash_in_link_sh_is_the_hash_of_that_copy(self):
        self.assertIn(hashlib.sha256(LEGACY_RULES.encode()).hexdigest(), LINK.read_text())

    def test_a_symlinked_rules_file_is_kept(self):
        mine = Path(self.directory.name) / "my-rules.md"
        mine.write_text(LEGACY_RULES)
        self.agents.mkdir()
        (self.agents / "AGENTS.md").symlink_to(mine)

        self.link()

        self.assertTrue((self.agents / "AGENTS.md").is_symlink())
        self.assertEqual(mine.read_text(), LEGACY_RULES)

    def test_a_copy_left_beside_the_rules_is_removed_once_they_are_updated(self):
        self.agents.mkdir()
        (self.agents / "AGENTS.md").write_text(LEGACY_RULES)
        shipped = (SKILLS / "rules" / "AGENTS.md").read_text()
        (self.agents / "AGENTS.hub-william.md").write_text(shipped)

        self.link()

        self.assertFalse((self.agents / "AGENTS.hub-william.md").exists())

    def test_an_existing_agent_file_is_left_as_it_is(self):
        (self.home / ".claude").mkdir()
        (self.home / ".claude" / "CLAUDE.md").write_text("mine")

        result = self.link()

        self.assertEqual((self.home / ".claude" / "CLAUDE.md").read_text(), "mine")
        self.assertIn("@" + str(self.agents / "AGENTS.md"), result.stdout)

    def test_refuses_to_write_through_a_symlinked_skills_folder(self):
        elsewhere = Path(self.directory.name) / "elsewhere"
        elsewhere.mkdir()
        self.agents.mkdir()
        (self.agents / "skills").symlink_to(elsewhere)

        result = run(LINK, self.home, "--path", str(SKILLS))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink", result.stderr)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_without_a_path_it_fetches_the_zip_from_hub_william(self):
        site = Path(self.directory.name) / "site"
        write_zip(site / "catalog" / "collections" / "synasapmob" / "tools" / "skills.zip")

        result = run(LINK, self.home, HUB_WILLIAM_ORIGIN=site.as_uri())

        self.assertEqual(result.returncode, 0, result.stderr)
        for name in SKILL_NAMES:
            self.assertTrue((self.agents / "skills" / name / "SKILL.md").is_file())
        self.assertTrue((self.agents / "AGENTS.md").is_file())

    def test_a_path_installs_from_your_own_zip_and_fetches_nothing(self):
        mine = write_zip(Path(self.directory.name) / "Downloads" / "skills.zip")

        result = run(
            LINK, self.home, "--path=" + str(mine), HUB_WILLIAM_ORIGIN="file:///nowhere"
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        for name in SKILL_NAMES:
            self.assertTrue((self.agents / "skills" / name / "SKILL.md").is_file())

    def test_a_path_can_be_the_folder_you_unzipped_it_into(self):
        mine = write_zip(Path(self.directory.name) / "skills.zip")
        unzipped = Path(self.directory.name) / "unzipped"
        with zipfile.ZipFile(mine) as archive:
            archive.extractall(unzipped)

        result = run(LINK, self.home, "--path=" + str(unzipped))

        self.assertEqual(result.returncode, 0, result.stderr)
        for name in SKILL_NAMES:
            self.assertTrue((self.agents / "skills" / name / "SKILL.md").is_file())

    def test_a_path_can_be_given_as_a_separate_argument(self):
        result = run(LINK, self.home, "--path", str(SKILLS))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.agents / "AGENTS.md").is_file())

    def test_a_leading_tilde_in_the_path_means_your_home(self):
        write_zip(self.home / "Downloads" / "skills.zip")

        result = run(LINK, self.home, "--path=~/Downloads/skills.zip")

        self.assertEqual(result.returncode, 0, result.stderr)
        for name in SKILL_NAMES:
            self.assertTrue((self.agents / "skills" / name / "SKILL.md").is_file())

    def test_a_path_that_does_not_exist_stops_without_installing(self):
        result = run(LINK, self.home, "--path=" + str(self.home / "missing.zip"))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not found", result.stderr)
        self.assertFalse(self.agents.exists())

    def test_a_file_that_is_not_a_zip_stops_without_installing(self):
        notes = self.home / "notes.txt"
        notes.write_text("hello")

        result = run(LINK, self.home, "--path=" + str(notes))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a zip file or a folder", result.stderr)
        self.assertFalse(self.agents.exists())

    def test_unlink_removes_what_was_installed_and_nothing_else(self):
        (self.home / ".claude").mkdir()
        (self.home / ".codex").mkdir()
        (self.home / ".gemini" / "config").mkdir(parents=True)
        (self.agents / "skills" / "mine").mkdir(parents=True)
        (self.agents / "skills" / "mine" / "SKILL.md").write_text("mine")
        self.link()

        result = run(UNLINK, self.home)

        self.assertEqual(result.returncode, 0, result.stderr)
        for name in SKILL_NAMES:
            self.assertFalse((self.agents / "skills" / name).exists())
            self.assertFalse((self.home / ".codex" / "skills" / name).is_symlink())
            self.assertTrue(
                list((self.agents / ".backups").glob("*/" + name + "/SKILL.md"))
            )
        self.assertFalse((self.home / ".claude" / "CLAUDE.md").is_symlink())
        self.assertFalse((self.home / ".claude" / "skills" / SKILL_NAMES[0]).is_symlink())
        self.assertFalse((self.home / ".codex" / "AGENTS.md").is_symlink())
        self.assertFalse((self.home / ".gemini" / "AGENTS.md").is_symlink())
        self.assertFalse(
            (self.home / ".gemini" / "config" / "skills" / SKILL_NAMES[0]).is_symlink()
        )
        self.assertTrue((self.agents / "AGENTS.md").is_file())
        self.assertEqual((self.agents / "skills" / "mine" / "SKILL.md").read_text(), "mine")
        self.assertFalse((self.agents / ".hub-william-skills").exists())

    def test_unlink_with_nothing_installed_is_harmless(self):
        result = run(UNLINK, self.home)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("nothing to remove", result.stdout)


if __name__ == "__main__":
    unittest.main()
