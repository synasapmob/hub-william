"""Catalogue boundaries and distribution; no account credentials or network."""

import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("provider_catalogue", ROOT / "scripts/provider-catalogue.py")
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)


class CatalogueTest(unittest.TestCase):
    def setUp(self):
        self.catalogue = json.loads(generator.SOURCE.read_text())

    def test_rejects_ambiguous_provider_and_model_ids(self):
        for duplicate in ("provider", "model", "surface"):
            with self.subTest(duplicate=duplicate):
                value = copy.deepcopy(self.catalogue)
                provider = value["providers"][0]
                if duplicate == "provider":
                    value["providers"].append(provider)
                elif duplicate == "model":
                    provider["models"].append(provider["models"][0])
                else:
                    value["surfaces"]["installers"].append(provider["id"])
                with self.assertRaises(ValueError):
                    generator.validate(value)

    def test_rejects_unknown_adapter_and_incomplete_native_config(self):
        provider = self.catalogue["providers"][0]
        provider["clients"]["opencode"]["npm"] = "@unknown/unsupported"
        with self.assertRaisesRegex(ValueError, "transport adapter"):
            generator.validate(self.catalogue)
        provider["clients"]["opencode"]["npm"] = "@ai-sdk/openai"
        del provider["native_cli"]["wire_api"]
        with self.assertRaisesRegex(ValueError, "native metadata"):
            generator.validate(self.catalogue)

    def test_rejects_wrong_call_capability_and_missing_dependency(self):
        call = next(c for c in self.catalogue["call_profiles"] if c["provider"] == "groq")
        call["models"]["tts"] = call["models"]["chat"]
        with self.assertRaisesRegex(ValueError, "wrong capability"):
            generator.validate(self.catalogue)
        call["models"]["tts"] = "missing-model"
        with self.assertRaisesRegex(ValueError, "unavailable"):
            generator.validate(self.catalogue)

    def test_audio_only_model_cannot_be_a_coding_default(self):
        provider = self.catalogue["providers"][0]
        provider["clients"]["opencode"]["preferred_models"] = ["gpt-live-1-codex"]
        with self.assertRaisesRegex(ValueError, "current Chat model"):
            generator.validate(self.catalogue)

    def test_embedded_metadata_cannot_break_python_literal(self):
        value = {"name": "A ''' quoted provider\\name\nwith newline"}
        namespace = {"json": json}
        exec(generator.embedded_json("DATA", value), namespace)
        self.assertEqual(namespace["DATA"], value)

    def test_new_model_propagates_and_retired_ids_remain_managed(self):
        provider = self.catalogue["providers"][0]
        provider["models"].append({
            "id": "future-chat-fixture", "name": "Future Chat fixture",
            "status": "preview", "capabilities": ["chat"],
        })
        self.catalogue["retired_hub_ids"] = ["hub-retired-fixture"]
        # Exercise new provider identifiers without adding a new transport.
        extra = copy.deepcopy(self.catalogue["providers"][4])
        extra.update(id="extra-provider", label="Extra Provider", catalogue_key="extra-provider", hub_id="hub-extra-provider")
        extra["auth"]["connect_path"] = "/agent-connections/extra-provider"
        self.catalogue["providers"].append(extra)
        for surface in self.catalogue["surfaces"].values():
            surface.append(extra["id"])
        generator.validate(self.catalogue)
        artifacts = dict(generator.artifacts(self.catalogue))
        self.assertIn("future-chat-fixture", artifacts["apps/frontend/src/services/provider-catalogue.generated.ts"])
        rust = artifacts["apps/api/src/provider_catalogue_generated.rs"]
        self.assertIn("ExtraProvider,", rust)
        self.assertIn('#[serde(rename = "extra-provider")]', rust)
        for client in ("opencode", "omp"):
            namespace = {"__name__": "fixture"}
            exec(artifacts["apps/frontend/public/" + client + ".py"], namespace)
            self.assertIn("extra-provider", namespace["PROVIDER_CATALOGUE"])
            self.assertIn("hub-retired-fixture", namespace["MANAGED_PROVIDER_IDS"])
            self.assertIn("future-chat-fixture", artifacts["contributors/default/tools/" + client + "/" + client + ".md"])
            if client == "opencode":
                # Bundled metadata must not grant access absent live discovery.
                configured = namespace["build_config"]({}, "https://example.test", "fixture", {"codex": [{"id": "gpt-6-sol"}]})
                self.assertNotIn("future-chat-fixture", configured["provider"]["hub-codex"]["models"])


if __name__ == "__main__":
    unittest.main()
