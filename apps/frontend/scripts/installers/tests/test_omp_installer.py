"""OMP installer tests without touching the operator's real config."""

import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError


FRONTEND_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = FRONTEND_ROOT / "public" / "omp.py"
SPEC = importlib.util.spec_from_file_location("omp_installer", str(SCRIPT))
omp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(omp)


class OmpInstallerTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="hub-omp-")
        self.addCleanup(self.home.cleanup)

    def test_build_document_preserves_unrelated_provider_bytes(self):
        existing = (
            "# personal models\n"
            "providers:\n"
            "  personal:\n"
            "    baseUrl: https://models.example/v1 # keep exactly\n"
            "    api: openai-completions\n"
            "    auth: none\n"
            "    models:\n"
            "      - id: local-model\n"
        )
        document, installed = omp.build_document(
            existing,
            "https://api.hub.example",
            "hw_gateway_secret",
            {
                "codex": [{"id": "gpt-live"}],
                "claude": [{"id": "claude-live", "display_name": "Claude Live"}],
                "gemini": [{"id": "gemini-live", "name": "Gemini Live"}],
                "grok": [{"id": "grok-live"}],
                "deepseek": [{"id": "deepseek-live"}],
            },
        )

        self.assertIn(existing, document)
        self.assertEqual(installed, list(omp.PROVIDER_IDS))
        self.assertIn('api: "openai-responses"', document)
        self.assertIn('api: "anthropic-messages"', document)
        self.assertIn('api: "google-generative-ai"', document)
        deepseek_block = document.split("  hub-deepseek:\n", 1)[1].split(
            omp.END, 1
        )[0]
        self.assertIn('api: "openai-responses"', deepseek_block)
        self.assertNotIn("contextWindow", deepseek_block)
        self.assertNotIn("maxTokens", deepseek_block)
        self.assertIn('apiKey: "hw_gateway_secret"', document)
        self.assertEqual(document.count(omp.BEGIN), 1)
        self.assertEqual(document.count(omp.END), 1)

    def test_rerun_replaces_only_the_managed_provider_block(self):
        first, _ = omp.build_document(
            "providers:\n  personal:\n    auth: none\n",
            "https://old.example",
            "hw_old_secret",
            {
                "codex": [{"id": "old-model"}],
                "claude": [],
                "gemini": [],
                "grok": [],
                "deepseek": [],
            },
        )
        second, installed = omp.build_document(
            first,
            "https://new.example",
            "hw_new_secret",
            {
                "codex": [],
                "claude": [{"id": "new-model"}],
                "gemini": [],
                "grok": [],
                "deepseek": [],
            },
        )

        self.assertEqual(installed, ["hub-claude", "hub-grok"])
        self.assertIn("  personal:\n    auth: none\n", second)
        self.assertNotIn("old.example", second)
        self.assertNotIn("old-model", second)
        self.assertIn("new.example", second)
        self.assertEqual(second.count(omp.BEGIN), 1)

    def test_preserves_four_space_provider_indentation_on_rerun(self):
        existing = (
            "providers:\n"
            "    personal:\n"
            "        baseUrl: http://localhost:1234/v1\n"
            "        api: openai-completions\n"
            "        auth: none\n"
        )
        catalogue = {"codex": [{"id": "gpt-live"}]}
        first, _ = omp.build_document(
            existing, "https://api.hub.example", "hw_gateway_secret", catalogue
        )
        second, _ = omp.build_document(
            first, "https://api.hub.example", "hw_gateway_secret", catalogue
        )
        self.assertEqual(first, second)
        self.assertIn(existing, first)
        self.assertIn("    hub-codex:", first.splitlines())
        self.assertNotIn("  hub-codex:", first.splitlines())

    def test_existing_hub_provider_outside_managed_block_is_refused(self):
        with self.assertRaisesRegex(ValueError, "outside Hub William"):
            omp.build_document(
                "providers:\n  hub-codex:\n    auth: none\n",
                "https://api.hub.example",
                "hw_gateway_secret",
                {"codex": [{"id": "gpt-live"}]},
            )

    def test_indented_duplicate_and_markers_outside_providers_are_refused(self):
        catalogue = {"codex": [{"id": "gpt-live"}]}
        with self.assertRaisesRegex(ValueError, "outside Hub William"):
            omp.build_document(
                'providers:\n    "hub-codex":\n      api: openai-responses\n',
                "https://api.hub.example",
                "hw_gateway_secret",
                catalogue,
            )
        with self.assertRaisesRegex(ValueError, "ambiguous Hub William"):
            omp.build_document(
                "providers:\n  personal:\n    auth: none\n"
                "settings:\n"
                + omp.BEGIN
                + "\n"
                + omp.END
                + "\n",
                "https://api.hub.example",
                "hw_gateway_secret",
                catalogue,
            )

    def test_existing_markers_do_not_hide_duplicate_provider(self):
        document, _ = omp.build_document(
            "providers:\n",
            "https://api.hub.example",
            "hw_gateway_secret",
            {"codex": [{"id": "gpt-live"}]},
        )
        document += "    'hub-codex':\n      auth: none\n"
        with self.assertRaisesRegex(ValueError, "outside Hub William"):
            omp.build_document(
                document,
                "https://api.hub.example",
                "hw_gateway_secret",
                {"codex": [{"id": "gpt-live"}]},
            )

    def test_install_discovers_models_and_writes_owner_only_yaml(self):
        terminal = io.StringIO()
        args = omp.parse_args(
            ["--url=https://api.hub.example", "--key=hw_gateway_secret"]
        )

        def models(_url, _key, provider):
            return [{"id": provider + "-live"}]

        with mock.patch.object(omp, "_gateway_models", side_effect=models) as gateway_models:
            self.assertEqual(omp.install(terminal, args, self.home.name), 0)

        path = os.path.join(self.home.name, ".omp", "agent", "models.yml")
        with open(path, encoding="utf-8") as handle:
            document = handle.read()
        for provider_id in omp.PROVIDER_IDS:
            self.assertIn("  %s:\n" % provider_id, document)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertIn("/model", terminal.getvalue())
        self.assertIn(
            mock.call("https://api.hub.example", "hw_gateway_secret", "gemini"),
            gateway_models.call_args_list,
        )

    def test_invalid_gateway_key_keeps_existing_yaml(self):
        path = os.path.join(self.home.name, ".omp", "agent", "models.yml")
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("providers:\n  personal:\n    auth: none\n")
        error = HTTPError(
            "https://api.hub.example/gateway/openai/v1/models",
            401,
            "Unauthorized",
            {},
            io.BytesIO(b'{"code":"invalid_gateway_key"}'),
        )
        args = omp.parse_args(
            ["--url=https://api.hub.example", "--key=hw_gateway_secret"]
        )
        with mock.patch.object(omp, "urlopen", side_effect=error):
            with self.assertRaisesRegex(ValueError, "invalid or revoked"):
                omp.install(io.StringIO(), args, self.home.name)
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "providers:\n  personal:\n    auth: none\n")
        self.assertFalse(os.path.exists(path + ".hub-william.bak"))

    def test_empty_discovery_does_not_install_grok_fallback_alone(self):
        args = omp.parse_args(
            ["--url=https://api.hub.example", "--key=hw_gateway_secret"]
        )
        with mock.patch.object(omp, "_gateway_models", return_value=[]):
            with self.assertRaisesRegex(ValueError, "no provider models"):
                omp.install(io.StringIO(), args, self.home.name)
        self.assertFalse(
            os.path.exists(os.path.join(self.home.name, ".omp", "agent", "models.yml"))
        )

    def test_uses_existing_models_yaml_and_refuses_legacy_json(self):
        agent = os.path.join(self.home.name, ".omp", "agent")
        os.makedirs(agent)
        yaml_path = os.path.join(agent, "models.yaml")
        with open(yaml_path, "w", encoding="utf-8") as handle:
            handle.write("providers:\n")
        self.assertEqual(omp._models_path(self.home.name), yaml_path)

        os.unlink(yaml_path)
        with open(os.path.join(agent, "models.json"), "w", encoding="utf-8") as handle:
            handle.write("{}")
        with self.assertRaisesRegex(ValueError, "run `omp models` once"):
            omp._read_document(omp._models_path(self.home.name))

    def test_gateway_url_rejects_cleartext_remote_origins(self):
        self.assertEqual(
            omp._validated_gateway_url("http://localhost:8080/"),
            "http://localhost:8080",
        )
        with self.assertRaises(ValueError):
            omp._validated_gateway_url("http://hub.example")


if __name__ == "__main__":
    unittest.main()
