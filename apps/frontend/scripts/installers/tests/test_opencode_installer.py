"""OpenCode installer tests without touching the operator's real config."""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError


FRONTEND_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = FRONTEND_ROOT / "public" / "opencode.py"
SPEC = importlib.util.spec_from_file_location("opencode_installer", str(SCRIPT))
opencode = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(opencode)


class OpenCodeInstallerTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="hub-opencode-")
        self.addCleanup(self.home.cleanup)

    def test_build_config_preserves_unrelated_settings_and_includes_grok(self):
        document = opencode.build_config(
            {"theme": "system", "provider": {"personal": {"npm": "custom"}}},
            "https://api.hub.example",
            "hw_gateway_secret",
            {
                "codex": [{"id": "gpt-live"}],
                "codex_metadata": [
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

        self.assertEqual(document["theme"], "system")
        self.assertEqual(document["provider"]["personal"], {"npm": "custom"})
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

    def test_empty_grok_catalogue_does_not_install_unverified_model(self):
        document = opencode.build_config(
            {},
            "https://api.hub.example",
            "hw_gateway_secret",
            {
                "codex": [],
                "claude": [],
                "deepseek": [],
                "gemini": [],
                "grok": [],
            },
        )
        self.assertNotIn("hub-grok", document["provider"])
        self.assertNotIn("model", document)

    def test_build_config_prefers_claude_when_codex_is_absent(self):
        document = opencode.build_config(
            {},
            "https://api.hub.example",
            "hw_gateway_secret",
            {
                "codex": [],
                "claude": [{"id": "claude-opus-5-5"}],
                "deepseek": [],
                "gemini": [],
                "grok": [],
            },
        )
        self.assertIn("hub-claude", document["provider"])
        self.assertEqual(
            document["model"], "hub-claude/claude-opus-5-5"
        )

    def test_current_codex_is_default_and_legacy_metadata_is_not_bundled(self):
        document = opencode.build_config(
            {},
            "https://api.hub.example",
            "hw_gateway_secret",
            {
                "codex": [
                    {"id": "gpt-6-astra"},
                    {"id": "gpt-6-sol"},
                    {"id": "gpt-5.6-sol"},
                ]
            },
        )
        self.assertEqual(document["model"], "hub-codex/gpt-6-sol")
        bundled_ids = {model[0] for model in opencode.DEFAULT_CODEX_MODELS}
        self.assertEqual(
            bundled_ids,
            {
                "gpt-6-astra",
                "gpt-6-sol",
                "gpt-6-luna",
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
            },
        )

    def test_codex_catalogue_uses_gateway_ids_with_local_metadata(self):
        models = opencode._codex_model_config(
            [{"id": "gpt-live"}, {"id": "gpt-new", "name": "GPT New"}],
            [
                {"model": "gpt-live", "displayName": "GPT Live"},
                {"model": "gpt-old", "displayName": "GPT Old"},
            ],
        )
        self.assertEqual(list(models), ["gpt-live", "gpt-new"])
        self.assertEqual(models["gpt-live"]["name"], "GPT Live")
        self.assertEqual(models["gpt-new"], {"name": "GPT New"})

    def test_refresh_clears_removed_hub_models_from_agent_routing(self):
        document = opencode.build_config(
            {
                "model": "hub-codex/gpt-old",
                "small_model": "hub-codex/gpt-old",
                "agent": {
                    "build": {
                        "model": "hub-codex/gpt-old",
                        "variant": "ultra",
                        "temperature": 0.5,
                    },
                    "explore": {"model": "personal/local"},
                },
            },
            "https://api.hub.example",
            "hw_gateway_secret",
            {"codex": [{"id": "gpt-new"}]},
        )
        self.assertEqual(document["model"], "hub-codex/gpt-new")
        self.assertNotIn("small_model", document)
        self.assertEqual(document["agent"]["build"], {"temperature": 0.5})
        self.assertEqual(document["agent"]["explore"], {"model": "personal/local"})

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
        plugin_path = os.path.join(
            self.home.name, ".config", "opencode", "plugins", "remember-model.mjs"
        )
        self.assertTrue(os.path.isfile(plugin_path))
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
        self.assertIn("hub-codex", document["provider"])
        self.assertNotIn("hub-deepseek", document["provider"])
        self.assertIn("file://" + plugin_path, document.get("plugin", []))
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertIn("/variants", terminal.getvalue())
        self.assertIn(
            "remember-model", terminal.getvalue()
        )
        self.assertIn(
            mock.call("https://api.hub.example", "hw_gateway_secret", "gemini"),
            gateway_models.call_args_list,
        )

    def test_install_preserves_existing_model_and_mcp(self):
        config_dir = os.path.join(
            self.home.name, ".config", "opencode"
        )
        os.makedirs(config_dir, exist_ok=True)
        path = os.path.join(config_dir, "opencode.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "model": "hub-codex/gpt-live",
                    "agent": {"build": {"variant": "ultra"}},
                    "mcp": {"linear": {"type": "remote", "url": "https://mcp.linear.app"}},
                },
                handle,
            )

        terminal = io.StringIO()
        args = opencode.parse_args(
            ["--url=https://api.hub.example", "--key=hw_gateway_secret"]
        )

        with mock.patch.object(
            opencode,
            "_gateway_models",
            return_value=[{"id": "gpt-live"}],
        ), mock.patch.object(
            opencode,
            "_codex_models",
            return_value=[{"model": "gpt-live"}],
        ):
            self.assertEqual(opencode.install(terminal, args, self.home.name), 0)

        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)

        self.assertEqual(document["model"], "hub-codex/gpt-live")
        self.assertEqual(document["agent"], {"build": {"variant": "ultra"}})
        self.assertIn("linear", document.get("mcp", {}))

    def test_invalid_gateway_key_keeps_existing_config(self):
        path = os.path.join(self.home.name, ".config", "opencode", "opencode.json")
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as handle:
            handle.write('{"theme":"system"}\n')
        error = HTTPError(
            "https://api.hub.example/gateway/openai/v1/models",
            401,
            "Unauthorized",
            {},
            io.BytesIO(b'{"code":"invalid_gateway_key"}'),
        )
        args = opencode.parse_args(
            ["--url=https://api.hub.example", "--key=hw_gateway_secret"]
        )
        with mock.patch.object(opencode, "urlopen", side_effect=error):
            with self.assertRaisesRegex(ValueError, "invalid or revoked"):
                opencode.install(io.StringIO(), args, self.home.name)
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), '{"theme":"system"}\n')
        self.assertFalse(os.path.exists(path + ".hub-william.bak"))

    def test_empty_discovery_does_not_install_grok_fallback_alone(self):
        args = opencode.parse_args(
            ["--url=https://api.hub.example", "--key=hw_gateway_secret"]
        )
        with mock.patch.object(opencode, "_gateway_models", return_value=[]):
            with self.assertRaisesRegex(ValueError, "no provider models"):
                opencode.install(io.StringIO(), args, self.home.name)
        self.assertFalse(
            os.path.exists(
                os.path.join(self.home.name, ".config", "opencode", "opencode.json")
            )
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
