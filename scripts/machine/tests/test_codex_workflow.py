"""Exercise the installed Codex policy, ownership and configuration boundary."""

import os
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness import Machine
from lib import tomlfile


class CodexWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.machine = Machine()
        self.addCleanup(self.machine.cleanup)

    def install(self, *args):
        result = self.machine.run('init', '--yes', '--contributor', 'synasapmob', *args)
        self.assertEqual(result.code, 0, result.out)
        return result

    def test_installs_three_standalone_roles_and_native_policy(self):
        self.install()
        directory = self.machine.home_path('.codex', 'agents')
        self.assertEqual(sorted(os.listdir(directory)), [
            'hub-reviewer.toml', 'hub-scout.toml', 'hub-verifier.toml',
        ])
        for filename in os.listdir(directory):
            path = os.path.join(directory, filename)
            role = tomlfile.load_data(self.machine.read(path))
            self.assertEqual(role['name'], filename[:-5])
            self.assertTrue(role['developer_instructions'])
            self.assertNotIn('.agents/skills/cmk-delivery-review', role['developer_instructions'])
            self.assertFalse(os.stat(path).st_mode & 0o222)
        config = tomlfile.load_data(self.machine.read(self.machine.home_path('.codex', 'config.toml')))
        self.assertIn('CMK is explicit-only', config['developer_instructions'])
        self.assertIn('hub-reviewer', config['developer_instructions'])
        self.assertIn('linear', config['mcp_servers'])
        result = self.machine.run('sync', '--yes')
        self.assertEqual(result.code, 0, result.out)
        self.assertIn('nothing to do', result.out)

    def test_preserves_user_instructions_and_unrelated_config_bytes(self):
        path = self.machine.home_path('.codex', 'config.toml')
        original = '# personal\n"developer_instructions" = """Keep my house style.\nPreserve it.""" # mine\nmodel = "my-model"\n\n[projects."/my/repo"]\ntrust_level = "trusted" # retained\n'
        self.machine.write(path, original)
        self.install()
        installed = self.machine.read(path)
        config = tomlfile.load_data(installed)
        self.assertTrue(config['developer_instructions'].startswith('Keep my house style.\nPreserve it.'))
        self.assertIn('# mine\nmodel = "my-model"\n\n[projects."/my/repo"]\ntrust_level = "trusted" # retained\n', installed)
        self.assertIn('CMK is explicit-only', config['developer_instructions'])

    def test_never_overwrites_a_foreign_role(self):
        path = self.machine.home_path('.codex', 'agents', 'hub-scout.toml')
        original = 'name = "hub-scout"\ndescription = "mine"\ndeveloper_instructions = "mine"\n'
        self.machine.write(path, original)
        result = self.install()
        self.assertIn('yours, not ours', result.out)
        self.assertEqual(self.machine.read(path), original)

    def test_repairs_owned_role_and_keeps_project_agents_untouched(self):
        self.install()
        role = self.machine.home_path('.codex', 'agents', 'hub-reviewer.toml')
        os.chmod(role, 0o644)
        self.machine.write(role, 'broken = true\n')
        project = self.machine.home_path('repo', '.codex', 'agents', 'cmk-delivery-implementer.toml')
        self.machine.write(project, 'original project role\n')
        result = self.machine.run('sync', '--yes')
        self.assertEqual(result.code, 0, result.out)
        self.assertEqual(tomlfile.load_data(self.machine.read(role))['name'], 'hub-reviewer')
        self.assertFalse(os.stat(role).st_mode & 0o222)
        self.assertEqual(self.machine.read(project), 'original project role\n')

    def test_dry_run_does_not_install_policy_or_roles(self):
        self.install('--dry-run')
        self.assertFalse(os.path.exists(self.machine.home_path('.codex')))

    def test_harness_off_removes_owned_roles_and_only_managed_instructions(self):
        config_path = self.machine.home_path('.codex', 'config.toml')
        self.machine.write(config_path, 'developer_instructions = "Keep mine."\nmodel="mine"\n')
        self.install()
        profile_path = self.machine.machine_path('profiles', 'local.toml')
        profile = self.machine.read(profile_path)
        current = tomlfile.load_data(profile)['codex']
        current['harness'] = False
        profile = tomlfile.upsert_table(profile, ('codex',), current)
        self.machine.write(profile_path, profile)
        foreign = self.machine.home_path('.codex', 'agents', 'personal.toml')
        self.machine.write(foreign, 'name="personal"\n')
        result = self.machine.run('sync', '--yes')
        self.assertEqual(result.code, 0, result.out)
        config = tomlfile.load_data(self.machine.read(config_path))
        self.assertEqual(config['developer_instructions'], 'Keep mine.')
        self.assertEqual(config['model'], 'mine')
        self.assertEqual(os.listdir(self.machine.home_path('.codex', 'agents')), ['personal.toml'])

    def test_malformed_policy_markers_preserve_config_and_report_problem(self):
        path = self.machine.home_path('.codex', 'config.toml')
        self.machine.write(path, 'developer_instructions = "<!-- hub-william:workflow begin -->"\n')
        result = self.machine.run('init', '--yes', '--contributor', 'synasapmob')
        self.assertNotEqual(result.code, 0, result.out)
        self.assertIn('ambiguous Hub workflow policy markers', result.out)
        value = tomlfile.load_data(self.machine.read(path))['developer_instructions']
        self.assertEqual(value, '<!-- hub-william:workflow begin -->')

    def test_default_has_no_personal_policy_or_roles(self):
        result = self.machine.run('init', '--yes')
        self.assertEqual(result.code, 0, result.out)
        config = tomlfile.load_data(self.machine.read(self.machine.home_path('.codex', 'config.toml')))
        self.assertNotIn('developer_instructions', config)
        self.assertFalse(os.path.exists(self.machine.home_path('.codex', 'agents')))
        harness = self.machine.read(self.machine.home_path('.codex', 'AGENTS.md'))
        self.assertNotIn('CMK', harness)
        self.assertNotIn('hub-scout', harness)

    def test_switch_to_default_removes_only_personal_contribution(self):
        self.install()
        result = self.machine.run('sync', '--yes', '--contributor', 'default')
        self.assertEqual(result.code, 0, result.out)
        config = tomlfile.load_data(self.machine.read(self.machine.home_path('.codex', 'config.toml')))
        self.assertNotIn('developer_instructions', config)
        self.assertEqual(os.listdir(self.machine.home_path('.codex', 'agents')), [])
        self.assertNotIn('CMK', self.machine.read(self.machine.home_path('.codex', 'AGENTS.md')))
        repeated = self.machine.run('sync', '--yes')
        self.assertIn('nothing to do', repeated.out)

    def test_invalid_contributor_preserves_installed_files(self):
        self.install()
        path = self.machine.home_path('.codex', 'config.toml')
        original = self.machine.read(path)
        for name in ('../synasapmob', 'missing-contributor'):
            result = self.machine.run('sync', '--yes', '--contributor', name)
            self.assertNotEqual(result.code, 0, result.out)
            self.assertEqual(self.machine.read(path), original)

    def test_codex_only_without_shared_preserves_other_agents_and_shell(self):
        self.machine.run('init', '--yes')
        paths = [self.machine.home_path('.claude', 'CLAUDE.md'),
                 self.machine.home_path('.grok', 'AGENTS.md'),
                 self.machine.home_path('.zshrc')]
        original = {path: self.machine.read(path) for path in paths}
        result = self.machine.run('sync', '--yes', '--agent', 'codex',
                                  '--contributor', 'synasapmob', '--no-shared', '--no-plugins')
        self.assertEqual(result.code, 0, result.out)
        for path, content in original.items():
            self.assertEqual(self.machine.read(path), content)
        self.assertIn('synasapmob workflow selection', self.machine.read(self.machine.home_path('.codex', 'AGENTS.md')))


class ContractPathTest(unittest.TestCase):
    def test_shared_harness_contract_references_resolve_on_disk(self):
        repo = Path(__file__).resolve().parents[3]
        harness = repo / 'contributors/default/libraries/harness'
        count = 0
        for source in [harness / 'AGENTS.md'] + list((harness / 'tags').glob('*.md')):
            for reference in re.findall(r'`([^`\n]+)`', source.read_text()):
                if reference.startswith(('../', '~/.hub-william/')) and reference.endswith(('.md', '.yaml')):
                    target = (repo / reference[len('~/.hub-william/'):]) if reference.startswith('~/') else source.parent / reference
                    self.assertTrue(target.is_file(), '%s -> %s' % (source, reference))
                    count += 1
        self.assertGreater(count, 10)


class RootValueEditTest(unittest.TestCase):
    def test_changes_only_root_value_including_multiline_and_quoted_keys(self):
        text = '# mine\n"developer_instructions" = \'\'\'First\nSecond\'\'\' # keep\n[tools]\nx = true\n'
        updated = tomlfile.upsert_root_value(text, 'developer_instructions', 'new\nvalue')
        self.assertEqual(updated, '# mine\n"developer_instructions" = "new\\nvalue" # keep\n[tools]\nx = true\n')
        self.assertEqual(tomlfile.load_data(updated)['developer_instructions'], 'new\nvalue')

    def test_inserts_before_tables_and_removes_only_owned_assignment(self):
        original = '# mine\n[tools]\nx = true\n'
        updated = tomlfile.upsert_root_value(original, 'developer_instructions', 'policy')
        self.assertEqual(tomlfile.load_data(updated)['developer_instructions'], 'policy')
        self.assertEqual(tomlfile.remove_root_value(updated, 'developer_instructions'), original)

    def test_duplicate_root_assignment_is_rejected(self):
        with self.assertRaises(tomlfile.TomlError):
            tomlfile.upsert_root_value('developer_instructions="a"\ndeveloper_instructions="b"\n', 'developer_instructions', 'new')
