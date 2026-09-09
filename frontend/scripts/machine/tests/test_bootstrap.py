"""The public Python bootstrap, without making network or home-directory writes."""

import importlib.util
from pathlib import Path
import tempfile
import unittest


FRONTEND_ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "hub_william_public_installer",
    FRONTEND_ROOT / "public/install.py",
)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hw-bootstrap-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.checkout = self.root / "checkout"
        self.project = self.root / "project"
        self.project.mkdir()
        (self.checkout / "contributors/default/libraries/harness").mkdir(
            parents=True
        )
        (self.checkout / "contributors/default/libraries/harness/AGENTS.md").write_text(
            "Read ~/.hub-william/contributors/default/rule.md\n",
            encoding="utf-8",
        )
        self.original_checkout = bootstrap.CHECKOUT
        bootstrap.CHECKOUT = self.checkout
        self.addCleanup(self.restore_checkout)

    def restore_checkout(self):
        bootstrap.CHECKOUT = self.original_checkout

    def test_project_install_preserves_existing_instructions_and_is_repeatable(self):
        agents = self.project / "AGENTS.md"
        agents.write_text("# Existing project rules\n", encoding="utf-8")

        bootstrap.install_project(str(self.project))
        bootstrap.install_project(str(self.project))

        installed = agents.read_text(encoding="utf-8")
        self.assertIn("# Existing project rules", installed)
        self.assertEqual(installed.count(bootstrap.BLOCK_BEGIN), 1)
        self.assertTrue((self.project / "CLAUDE.md").is_file())

        copied = (
            self.project
            / ".agents/rules/hub-william/contributors/default/libraries/harness/AGENTS.md"
        ).read_text(encoding="utf-8")
        self.assertIn(".agents/rules/hub-william/contributors", copied)
        self.assertNotIn("~/.hub-william/", copied)

    def test_project_install_refuses_an_unowned_rule_directory(self):
        target = self.project / bootstrap.PROJECT_RULES
        target.mkdir(parents=True)
        (target / "mine.txt").write_text("keep", encoding="utf-8")

        with self.assertRaises(SystemExit):
            bootstrap.install_project(str(self.project))

        self.assertEqual((target / "mine.txt").read_text(encoding="utf-8"), "keep")

    def test_mcp_product_aliases_expand_to_real_registry_entries(self):
        registry = self.checkout / "frontend/scripts/machine/registries/mcp"
        registry.mkdir(parents=True)
        for name in (
            "chrome-devtools",
            "linear",
            "notion",
            "playwright",
            "supabase-one",
            "supabase-two",
        ):
            (registry / (name + ".toml")).write_text("description = \"x\"\n")

        self.assertEqual(
            bootstrap.selected_mcp_servers("chrome-browser,supabase"),
            ["chrome-devtools", "supabase-one", "supabase-two"],
        )
        self.assertEqual(
            bootstrap.selected_mcp_servers("all"),
            [
                "chrome-devtools",
                "linear",
                "notion",
                "playwright",
                "supabase-one",
                "supabase-two",
            ],
        )


if __name__ == "__main__":
    unittest.main()
