#!/usr/bin/env python3
"""Validate the shared catalogue and generate its distribution artifacts.

No network or credentials are needed. Live model discovery stays in the gateway;
this command distributes reviewed metadata, never guesses new available models.
"""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "apps/api/src/provider_catalogue.json"
CAPABILITIES = {"chat", "image_input", "realtime_audio", "transcription", "speech_output"}
EFFORTS = {"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, required, optional=()):
    require(isinstance(value, dict), "expected an object")
    require(set(required) <= value.keys(), "missing fields: " + str(set(required) - value.keys()))
    require(value.keys() <= set(required) | set(optional), "unknown fields: " + str(value.keys() - set(required) - set(optional)))


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_-]*", value), "invalid identifier: " + str(value))


def rust_variant(identifier):
    return "".join(part.capitalize() for part in re.split(r"[-_]", identifier))


def embedded_json(name, value):
    # Escape apostrophes as JSON Unicode sequences so metadata cannot terminate
    # the standalone Python script's triple-quoted string.
    payload = json.dumps(value, indent=2, ensure_ascii=False).replace("'", "\\u0027")
    return name + " = json.loads(r'''\n" + payload + "\n''')"


def path(value):
    require(isinstance(value, str) and value.startswith("/gateway/") and ".." not in value and "#" not in value and not any(c.isspace() for c in value), "invalid gateway path")


def unique(values, label):
    require(len(values) == len(set(values)), "duplicate " + label)


def validate(catalogue):
    fields(catalogue, ("schema_version", "providers", "call_profiles", "surfaces", "opencode_default_providers", "retired_hub_ids"))
    require(type(catalogue["schema_version"]) is int and catalogue["schema_version"] == 1, "unsupported catalogue schema version")
    require(isinstance(catalogue["providers"], list) and catalogue["providers"], "providers must be nonempty")
    for p in catalogue["providers"]:
        fields(p, ("id", "label", "connect_label", "icon", "catalogue_key", "hub_id", "auth", "usage_metrics", "chat_capabilities", "discovery", "gateway", "clients", "models"), ("native_cli",))
        for key in ("id", "catalogue_key", "hub_id"):
            identifier(p[key])
        require(p["hub_id"].startswith("hub-"), "managed provider IDs must start with hub-")
        for key in ("label", "connect_label", "icon"):
            require(isinstance(p[key], str) and p[key], "empty provider " + key)
        require(p["icon"].startswith("assets/") and ".." not in p["icon"], "icon must be a local asset")
        require(type(p["usage_metrics"]) is bool, "usage_metrics must be boolean")
        require(set(p["chat_capabilities"]) <= {"chat", "image_input"} and "chat" in p["chat_capabilities"], "invalid chat capabilities")
        fields(p["auth"], ("kind",), ("connect_path", "key_placeholder"))
        require(p["auth"]["kind"] in ("oauth", "api_key"), "invalid auth kind")
        if p["auth"]["kind"] == "api_key":
            require(p["auth"].get("connect_path") == "/agent-connections/" + p["id"] and p["auth"].get("key_placeholder"), "API-key connection metadata is incomplete")
        fields(p["discovery"], ("strategy", "docs_url"))
        require(p["discovery"]["strategy"] in ("official_docs", "live_intersection"), "invalid discovery strategy")
        require(p["discovery"]["docs_url"].startswith("https://"), "official source must use HTTPS")
        fields(p["gateway"], ("base_path", "models_path", "owned_by"))
        path(p["gateway"]["base_path"])
        path(p["gateway"]["models_path"])
        fields(p["clients"], (), ("opencode", "omp"))
        oc = p["clients"].get("opencode")
        if oc:
            fields(oc, ("npm", "auth", "effort_option", "metadata_adapter", "preferred_models"))
            require(oc["npm"] in ("@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/google"), "unknown OpenCode transport adapter")
            require(oc["auth"] in ("api_key", "auth_token", "bearer_header"), "invalid OpenCode auth")
            require(oc["effort_option"] in (None, "effort", "reasoningEffort"), "invalid effort option")
            require(oc["metadata_adapter"] in (None, "codex_app_server"), "unknown metadata adapter")
        if "omp" in p["clients"]:
            fields(p["clients"]["omp"], ("api",))
            require(p["clients"]["omp"]["api"] in ("openai-responses", "anthropic-messages", "google-generative-ai"), "unknown OMP transport adapter")
        for m in p["models"]:
            fields(m, ("id", "name", "status", "capabilities"), ("reasoning_efforts",))
            require(isinstance(m["id"], str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", m["id"]), "invalid model ID")
            require(isinstance(m["name"], str) and m["name"], "empty model name")
            require(m["status"] in ("current", "preview", "deprecated"), "invalid model status")
            require(isinstance(m["capabilities"], list) and m["capabilities"] and set(m["capabilities"]) <= CAPABILITIES, "invalid model capabilities")
            unique(m["capabilities"], "capability")
            if "reasoning_efforts" in m:
                require(isinstance(m["reasoning_efforts"], list) and set(m["reasoning_efforts"]) <= EFFORTS, "invalid reasoning efforts")
                unique(m["reasoning_efforts"], "reasoning effort")
        unique([m["id"] for m in p["models"]], "model ID within " + p["id"])
        current_chat = {m["id"] for m in p["models"] if m["status"] != "deprecated" and "chat" in m["capabilities"]}
        require(current_chat, "provider must define at least one current Chat model")
        if oc:
            require(set(oc["preferred_models"]) <= current_chat, "preferred model must be a current Chat model")
        if "native_cli" in p:
            cli = p["native_cli"]
            fields(cli, ("id", "label", "path", "base_path", "protocol"), ("wire_api", "model_provider", "model_key"))
            require(cli["id"] in ("codex", "claude", "agy", "grok"), "unknown native CLI renderer")
            if cli["id"] == "codex":
                require(cli.get("wire_api") == "responses", "Codex native metadata is incomplete")
            if cli["id"] == "agy":
                require(cli.get("model_provider") == "gemini", "AGY native metadata is incomplete")
            if cli["id"] == "grok":
                require(cli.get("model_key"), "Grok native metadata is incomplete")
            require(isinstance(cli["path"], str) and cli["path"].startswith(".") and ".." not in cli["path"], "invalid native CLI config path")
            path(cli["base_path"])
    for key in ("id", "label", "catalogue_key", "hub_id"):
        unique([p[key] for p in catalogue["providers"]], "provider " + key)
    unique([rust_variant(p["id"]) for p in catalogue["providers"]], "Rust provider variant")
    require(isinstance(catalogue["retired_hub_ids"], list), "retired_hub_ids must be a list")
    for retired in catalogue["retired_hub_ids"]:
        identifier(retired)
        require(retired.startswith("hub-"), "retired provider IDs must start with hub-")
    unique([p["hub_id"] for p in catalogue["providers"]] + catalogue["retired_hub_ids"], "managed provider ID")
    unique([p["native_cli"]["id"] for p in catalogue["providers"] if "native_cli" in p], "native CLI")
    providers = {p["id"]: p for p in catalogue["providers"]}
    fields(catalogue["surfaces"], ("agents", "connect", "playground", "installers"))
    for surface, order in catalogue["surfaces"].items():
        require(isinstance(order, list) and set(order) == set(providers), "surface must list each provider: " + surface)
        unique(order, "surface provider")
    require(set(catalogue["opencode_default_providers"]) <= set(providers), "unknown default provider")
    for pid in catalogue["opencode_default_providers"]:
        require("opencode" in providers[pid]["clients"], "default provider must support OpenCode")
    for call in catalogue["call_profiles"]:
        fields(call, ("id", "provider", "name", "kind", "transport", "selector_model", "availability", "models"))
        identifier(call["id"])
        require(call["provider"] in providers, "unknown call provider")
        definitions = {m["id"]: m for m in providers[call["provider"]]["models"]}
        if call["kind"] == "native_realtime":
            require(call["provider"] == "chatgpt" and call["transport"] == "codex_v3_webrtc" and call["availability"] == "chat_catalogue", "unknown native call adapter")
            roles = {"realtime": "realtime_audio"}
            selector_role = "realtime"
        else:
            require(call["provider"] == "groq" and call["kind"] == "local_stt_llm_tts" and call["transport"] == "groq_sse" and call["availability"] == "all_dependencies", "unknown composed call adapter")
            roles = {"chat": "chat", "tts": "speech_output"}
            selector_role = "chat"
        require(set(call["models"]) == set(roles), "missing call pipeline roles")
        for role, capability in roles.items():
            model = definitions.get(call["models"][role])
            require(model and model["status"] != "deprecated" and capability in model["capabilities"], "call dependency is unavailable or has the wrong capability")
        require(call["selector_model"] == call["models"][selector_role], "call selector must match its native/Chat model")
    unique([c["id"] for c in catalogue["call_profiles"]], "call profile")
    unique([c["id"].upper().replace('-', '_') for c in catalogue["call_profiles"]], "Rust call constant")
    unique([(c["provider"], c["selector_model"]) for c in catalogue["call_profiles"]], "call selector")
    return catalogue


def formatted(text, parser):
    result = subprocess.run(["pnpm", "--dir", "apps/frontend", "exec", "prettier", "--parser", parser], cwd=ROOT, input=text, text=True, capture_output=True, check=True)
    return result.stdout


def replace_block(text, begin, end, body):
    require(text.count(begin) == 1 and text.count(end) == 1, "missing or duplicate generated markers: " + begin)
    before, rest = text.split(begin, 1)
    _, after = rest.split(end, 1)
    return before + begin + "\n" + body.rstrip() + "\n" + end + after


def installer_data(catalogue, client):
    by_id = {p["id"]: p for p in catalogue["providers"]}
    result = {}
    for pid in catalogue["surfaces"]["installers"]:
        p = by_id[pid]
        if client not in p["clients"]:
            continue
        entry = {"id": pid, "hub_id": p["hub_id"], "name": "Hub William · " + p["connect_label"], **p["gateway"], **p["clients"][client]}
        if client == "opencode" and entry["metadata_adapter"]:
            entry["model_metadata"] = [m for m in p["models"] if "chat" in m["capabilities"] and m["status"] != "deprecated"]
        result[p["catalogue_key"]] = entry
    return result


def artifacts(catalogue):
    providers = catalogue["providers"]
    ts_template = (ROOT / "scripts/provider-catalogue/typescript.template").read_text()
    ts = ts_template.replace("__PROVIDER_IDS__", " | ".join(json.dumps(p["id"]) for p in providers))
    ts = ts.replace("__PROVIDER_LABELS__", " | ".join(json.dumps(p["label"]) for p in providers))
    ts = ts.replace("__API_KEY_PROVIDERS__", " | ".join(json.dumps(p["id"]) for p in providers if p["auth"]["kind"] == "api_key") or "never")
    ts = ts.replace("__API_KEY_PATHS__", " | ".join(json.dumps(p["auth"]["connect_path"]) for p in providers if p["auth"]["kind"] == "api_key") or "never")
    ts = ts.replace("__CATALOGUE__", json.dumps(catalogue, indent=2, ensure_ascii=False))
    yield "apps/frontend/src/services/provider-catalogue.generated.ts", formatted(ts, "typescript")

    rust = ['// Generated by scripts/provider-catalogue.py. Edit provider_catalogue.json.\n', 'use serde::{Deserialize, Serialize};\nuse utoipa::ToSchema;\n', '#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, ToSchema)]\n#[serde(rename_all = "snake_case")]\npub enum AgentProvider {']
    rust.extend('    #[serde(rename = ' + json.dumps(p["id"]) + ')]\n    ' + rust_variant(p["id"]) + ',' for p in providers)
    rust.append('}\nimpl AgentProvider {\n    pub(crate) const ALL: [Self; ' + str(len(providers)) + '] = [')
    rust.extend('Self::' + rust_variant(p["id"]) + ',' for p in providers)
    rust.append('];\n    pub(crate) fn as_str(self) -> &\'static str {\n        match self {')
    rust.extend('Self::' + rust_variant(p["id"]) + ' => ' + json.dumps(p["id"]) + ',' for p in providers)
    rust.append('}\n}\n}\n')
    for call in catalogue["call_profiles"]:
        for role, mid in call["models"].items():
            name = 'CALL_' + call["id"].upper().replace('-', '_') + '_' + role.upper() + '_MODEL'
            rust.append('pub(crate) const ' + name + ': &str = ' + json.dumps(mid) + ';')
    result = subprocess.run(["rustfmt", "--edition", "2024"], input='\n'.join(rust)+'\n', text=True, capture_output=True, check=True)
    yield "apps/api/src/provider_catalogue_generated.rs", result.stdout

    for client in ("opencode", "omp", "gateway"):
        filename = "apps/frontend/public/" + client + ".py"
        if client == "gateway":
            data = {p["native_cli"]["id"]: p["native_cli"] for p in providers if "native_cli" in p}
            body = embedded_json("NATIVE_CLIENTS", data)
        else:
            body = embedded_json("PROVIDER_CATALOGUE", installer_data(catalogue, client))
            body += '\nMANAGED_PROVIDER_IDS = ' + repr(tuple([p["hub_id"] for p in providers] + catalogue["retired_hub_ids"]))
            if client == "opencode":
                by_id = {p["id"]: p for p in providers}
                body += '\nDEFAULT_PROVIDERS = ' + repr([by_id[pid]["catalogue_key"] for pid in catalogue["opencode_default_providers"]])
        text = (ROOT / filename).read_text()
        yield filename, replace_block(text, "# provider-catalogue: begin (generated)", "# provider-catalogue: end", body)

    rows = ["| Provider | Chat models in the reviewed catalogue | Call | Client protocol |", "|---|---|---|---|"]
    by_id = {p["id"]: p for p in providers}
    for client in ("opencode", "omp", "gateway"):
        body = rows[:]
        for pid in catalogue["surfaces"]["installers"]:
            p = by_id[pid]
            if client == "gateway" and "native_cli" not in p:
                continue
            if client != "gateway" and client not in p["clients"]:
                continue
            models = ", ".join('`'+m["id"]+'`'+(' (preview)' if m["status"] == "preview" else '') for m in p["models"] if "chat" in m["capabilities"] and m["status"] != "deprecated")
            calls = [c for c in catalogue["call_profiles"] if c["provider"] == pid]
            call = "; ".join("Playground: " + ("native realtime" if c["kind"] == "native_realtime" else "Local STT → Chat → TTS") for c in calls) or "—"
            protocol = p["native_cli"]["protocol"] if client == "gateway" else p["clients"][client]["npm" if client == "opencode" else "api"]
            body.append('| '+p["connect_label"]+' | '+models+' | '+call+' | `'+protocol+'` |')
        body.append("\nGenerated from `apps/api/src/provider_catalogue.json`. Model availability is checked live through Hub; this reviewed snapshot is not proof of account access. Call profiles are Playground-only; coding-client lists contain only chat-capable model IDs.")
        filename = 'contributors/default/tools/'+client+'/'+client+'.md'
        text = (ROOT/filename).read_text()
        yield filename, replace_block(text, "<!-- provider-catalogue: begin (generated) -->", "<!-- provider-catalogue: end -->", formatted('\n'.join(body)+'\n', 'markdown'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated consumers differ; never write")
    args = parser.parse_args()
    catalogue = validate(json.loads(SOURCE.read_text()))
    changed = []
    for filename, content in artifacts(catalogue):
        target = ROOT / filename
        if target.exists() and target.read_text() == content:
            continue
        changed.append(filename)
        if not args.check:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
    if args.check and changed:
        raise ValueError("stale catalogue artifacts; run pnpm catalogue:generate:\n" + '\n'.join(changed))
    print("Catalogue valid; " + (str(len(changed)) + " artifacts generated." if not args.check else "all consumers are synchronized."))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print("Provider catalogue: " + str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
