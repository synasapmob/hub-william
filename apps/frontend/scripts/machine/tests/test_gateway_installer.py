"""Gateway installer config merging without touching the real home directory."""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from unittest import mock


REPO_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
)
SCRIPT = os.path.join(REPO_ROOT, "frontend", "public", "gateway.py")
SPEC = importlib.util.spec_from_file_location("gateway_installer", SCRIPT)
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


class GatewayInstallerTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="hub-gateway-")
        self.addCleanup(self.home.cleanup)

    def write(self, relative, text):
        path = os.path.join(self.home.name, relative)
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def test_build_changes_preserves_unrelated_agent_configuration(self):
        codex_path = self.write(
            ".codex/config.toml",
            'model = "gpt-existing"\n\n[projects."/work"]\ntrust_level = "trusted"\n',
        )
        claude_path = self.write(
            ".claude/settings.json",
            json.dumps({"permissions": {"allow": ["Read"]}}),
        )
        grok_path = self.write(
            ".grok/config.toml",
            '[telemetry]\nenabled = false\n',
        )

        changes = gateway.build_changes(
            self.home.name,
            "hw_test_gateway_key",
            "https://gateway.example.com",
            ["codex", "claude", "grok"],
        )

        self.assertIn('model = "gpt-existing"', changes[codex_path])
        self.assertIn('[projects."/work"]', changes[codex_path])
        self.assertIn("[model_providers.hub-william]", changes[codex_path])
        self.assertEqual(
            json.loads(changes[claude_path])["permissions"], {"allow": ["Read"]}
        )
        self.assertEqual(
            json.loads(changes[claude_path])["env"]["ANTHROPIC_AUTH_TOKEN"],
            "hw_test_gateway_key",
        )
        self.assertIn("[telemetry]", changes[grok_path])
        self.assertIn("[model.grok-build]", changes[grok_path])

    def test_gateway_url_requires_https_except_for_local_testing(self):
        self.assertEqual(
            gateway._validated_gateway_url("http://localhost:8080/"),
            "http://localhost:8080",
        )
        with self.assertRaises(ValueError):
            gateway._validated_gateway_url("http://gateway.example.com")

    def test_terminal_menu_uses_arrows_space_enter_and_escape(self):
        class Terminal:
            def __init__(self):
                self.output = ""

            def fileno(self):
                return 42

            def flush(self):
                return None

            def write(self, value):
                self.output += value

        def choose(keys):
            terminal = Terminal()
            with mock.patch.object(
                gateway.termios, "tcgetattr", return_value=[]
            ), mock.patch.object(gateway.termios, "tcsetattr"), mock.patch.object(
                gateway.tty, "setcbreak"
            ), mock.patch.object(
                gateway, "_read_key", side_effect=keys
            ):
                result = gateway.choose_agents(terminal)
            self.assertIn("↑/↓ move", terminal.output)
            return result

        self.assertEqual(choose(["down", "space", "enter"]), ["codex", "grok"])
        self.assertIsNone(choose(["escape"]))

    def test_raw_key_reader_recognizes_arrow_and_escape_sequences(self):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"\x1b[B")
            self.assertEqual(gateway._read_key(read_fd), "down")
            os.write(write_fd, b"\x1b")
            self.assertEqual(gateway._read_key(read_fd), "escape")
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_enter_flow_prompts_once_and_writes_the_key_to_selected_configs(self):
        destination = os.path.join(self.home.name, "config.toml")
        terminal = io.StringIO()
        with mock.patch.dict(
            os.environ,
            {"HUB_WILLIAM_GATEWAY_URL": "https://gateway.example.com"},
            clear=False,
        ), mock.patch.object(
            gateway, "choose_agents", return_value=["codex", "claude"]
        ), mock.patch.object(
            gateway.getpass, "getpass", return_value="hw_live_test-install-key"
        ) as prompt, mock.patch.object(
            gateway,
            "build_changes",
            return_value={destination: "api_key = \"hw_live_test-install-key\"\n"},
        ):
            self.assertEqual(gateway.install(terminal), 0)

        prompt.assert_called_once_with("Hub William API key: ", stream=terminal)
        with open(destination, encoding="utf-8") as handle:
            self.assertIn("hw_live_test-install-key", handle.read())


if __name__ == "__main__":
    unittest.main()
