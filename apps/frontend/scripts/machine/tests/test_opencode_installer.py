"""OpenCode installer tests without touching the operator's real config."""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


FRONTEND_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = FRONTEND_ROOT / "public" / "opencode.py"
SPEC = importlib.util.spec_from_file_location("opencode_installer", str(SCRIPT))
opencode = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(opencode)


class OpenCodeInstallerTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="hub-opencode-")
        self.addCleanup(self.home.cleanup)

    def test_build_config_overwrites_old_settings_and_includes_grok(self):
        document = opencode.build_config(
            {"theme": "system", "provider": {"personal": {"npm": "custom"}}},
            "https://api.hub.example",
            "hw_gateway_secret",
            {
                "codex": [
                    {
                        "model": "gpt-live",
                        "displayName": "GPT Live",
                        "supportedReasoningEfforts": [
                            {"reasoningEffort": "medium"},
                            {"reasoningEffort": "ultra"},
                        ],
                    }
                ],
                "claude": [
                    {
                        "id": "claude-sonnet-live",
                        "display_name": "Sonnet",
                        "capabilities": {
                            "effort": {
                                "supported": True,
                                "low": {"supported": True},
                                "medium": {"supported": True},
                                "high": {"supported": True},
                            }
                        },
                    }
                ],
                "deepseek": [{"id": "deepseek-v4-pro"}],
                "gemini": [
                    {
                        "id": "gemini-3.8-flash-medium",
                        "name": "Gemini 3.8 Flash (Medium)",
                    }
                ],
                "grok": [{"id": "grok-build"}],
            },
        )

        self.assertNotIn("theme", document)
        self.assertNotIn("personal", document["provider"])
        self.assertEqual(document["model"], "hub-codex/gpt-live")
        self.assertEqual(
            list(
                document["provider"]["hub-codex"]["models"]["gpt-live"][
                    "variants"
                ]
            ),
            ["medium", "ultra"],
        )
        self.assertEqual(
            document["provider"]["hub-deepseek"]["options"]["apiKey"],
            "hw_gateway_secret",
        )
        self.assertEqual(
            document["provider"]["hub-claude"]["options"]["authToken"],
            "hw_gateway_secret",
        )
        self.assertNotIn("apiKey", document["provider"]["hub-claude"]["options"])
        self.assertEqual(
            document["provider"]["hub-gemini"]["options"]["headers"],
            {"Authorization": "Bearer hw_gateway_secret"},
        )
        self.assertEqual(
            document["provider"]["hub-gemini"]["options"]["apiKey"],
            "hub-william",
        )
        self.assertEqual(
            document["provider"]["hub-grok"]["npm"],
            "@ai-sdk/openai",
        )
        self.assertEqual(
            document["provider"]["hub-deepseek"]["npm"],
            "@ai-sdk/openai",
        )
        deepseek_model = document["provider"]["hub-deepseek"]["models"][
            "deepseek-v4-pro"
        ]
        self.assertNotIn("contextWindow", deepseek_model)
        self.assertNotIn("maxTokens", deepseek_model)
        self.assertEqual(
            document["provider"]["hub-claude"]["models"][
                "claude-sonnet-live"
            ]["variants"]["medium"],
            {"effort": "medium"},
        )
        self.assertIn("opencode", document["disabled_providers"])

    def test_unreachable_pool_keeps_grok_provider_for_reconnect(self):
        document = opencode.build_config(
            {},
            "https://api.hub.example",
            "hw_gateway_secret",
            {
                "codex": None,
                "claude": [],
                "deepseek": [],
                "gemini": [],
                "grok": [],
            },
        )
        self.assertEqual(
            document["provider"]["hub-grok"]["models"],
            {"grok-build": {"name": "Grok Build"}},
        )
        self.assertNotIn("model", document)

    def test_reads_jsonc_and_preserves_unrelated_values(self):
        path = os.path.join(
            self.home.name, ".config", "opencode", "opencode.json"
        )
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(
                '{\n // keep semantically\n "theme": "system",\n "permission": {"bash": "ask",},\n}\n'
            )
        self.assertEqual(
            opencode._read_document(path),
            {"theme": "system", "permission": {"bash": "ask"}},
        )

    def test_install_discovers_models_and_writes_owner_only_config(self):
        terminal = io.StringIO()
        args = opencode.parse_args(
            ["--url=https://api.hub.example", "--key=hw_gateway_secret"]
        )

        def models(_url, _key, provider):
            return [{"id": "gpt-live"}] if provider == "codex" else []

        with mock.patch.object(opencode, "_gateway_models", side_effect=models) as gateway_models, mock.patch.object(
            opencode,
            "_codex_models",
            return_value=[
                {
                    "model": "gpt-live",
                    "displayName": "GPT Live",
                    "supportedReasoningEfforts": [
                        {"reasoningEffort": "medium"}
                    ],
                }
            ],
        ):
            self.assertEqual(opencode.install(terminal, args, self.home.name), 0)

        path = os.path.join(
            self.home.name, ".config", "opencode", "opencode.json"
        )
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
        self.assertIn("hub-codex", document["provider"])
        self.assertNotIn("hub-deepseek", document["provider"])
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertIn("/variants", terminal.getvalue())
        self.assertIn(
            mock.call("https://api.hub.example", "hw_gateway_secret", "gemini"),
            gateway_models.call_args_list,
        )

    def test_gateway_url_rejects_cleartext_remote_origins(self):
        self.assertEqual(
            opencode._validated_gateway_url("http://localhost:8080/"),
            "http://localhost:8080",
        )
        with self.assertRaises(ValueError):
            opencode._validated_gateway_url("http://hub.example")

    def test_key_flag_never_opens_the_terminal_device(self):
        with mock.patch.object(opencode, "install", return_value=0) as install, mock.patch(
            "builtins.open", side_effect=AssertionError("/dev/tty must not be opened")
        ):
            self.assertEqual(
                opencode.main(
                    [
                        "--url=https://api.hub.example",
                        "--key=hw_gateway_secret",
                    ]
                ),
                0,
            )

        self.assertIs(install.call_args.args[0], opencode.sys.stderr)


if __name__ == "__main__":
    unittest.main()
