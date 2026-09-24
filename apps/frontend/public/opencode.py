#!/usr/bin/env python3
"""Install a live Hub William provider catalogue into OpenCode.

    curl -fsSL https://<hub>/opencode.py | python3 - --url=https://<api>
"""

import argparse
import copy
import getpass
import json
import os
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


DEFAULT_CODEX_MODELS = (
    (
        "gpt-6-astra",
        "GPT-6 Astra",
        ("low", "medium", "high", "xhigh", "max", "ultra"),
    ),
    (
        "gpt-6-sol",
        "GPT-6 Sol",
        ("low", "medium", "high", "xhigh", "max", "ultra"),
    ),
    ("gpt-6-luna", "GPT-6 Luna", ("low", "medium", "high", "xhigh", "max")),
    (
        "gpt-5.6-sol",
        "GPT-5.6 Sol",
        ("low", "medium", "high", "xhigh", "max", "ultra"),
    ),
    (
        "gpt-5.6-terra",
        "GPT-5.6 Terra",
        ("low", "medium", "high", "xhigh", "max", "ultra"),
    ),
    ("gpt-5.6-luna", "GPT-5.6 Luna", ("low", "medium", "high", "xhigh", "max")),
    ("gpt-5.5", "GPT-5.5", ("low", "medium", "high", "xhigh")),
    (
        "gpt-5.3-codex-spark",
        "GPT-5.3 Codex Spark",
        ("low", "medium", "high", "xhigh"),
    ),
)

DEFAULT_GROK_MODELS = [{"id": "grok-build", "name": "Grok Build"}]

REMEMBER_MODEL_PLUGIN_SOURCE = """import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");

function updateGlobalConfig({ providerID, modelID, variant, agent, explicitVariant = true }) {
  if (!providerID || !modelID) return;

  const targetAgent = (!agent || agent === "all") ? "build" : agent;
  if (["compaction", "title", "summary", "explore"].includes(targetAgent)) return;

  const modelKey = `${providerID}/${modelID}`;

  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw);

    const prevModel = config.model;
    const prevVariant = config.agent?.[targetAgent]?.variant;

    const normalizedVariant = (variant && variant !== "default") ? variant : undefined;

    if (!explicitVariant && prevModel === modelKey) {
      return;
    }

    if (explicitVariant && prevModel === modelKey && prevVariant === normalizedVariant) {
      return;
    }

    config.model = modelKey;

    if (explicitVariant) {
      if (normalizedVariant) {
        config.agent = config.agent || {};
        config.agent[targetAgent] = config.agent[targetAgent] || {};
        config.agent[targetAgent].model = modelKey;
        config.agent[targetAgent].variant = normalizedVariant;
      } else {
        if (config.agent?.[targetAgent]) {
          delete config.agent[targetAgent].variant;
          if (config.agent[targetAgent].model === modelKey) {
            delete config.agent[targetAgent].model;
          }
          if (Object.keys(config.agent[targetAgent]).length === 0) {
            delete config.agent[targetAgent];
          }
        }
        if (config.agent && Object.keys(config.agent).length === 0) {
          delete config.agent;
        }
      }
    } else {
      if (config.agent?.[targetAgent]?.model && config.agent[targetAgent].model !== modelKey) {
        delete config.agent[targetAgent].variant;
        delete config.agent[targetAgent].model;
        if (Object.keys(config.agent[targetAgent]).length === 0) {
          delete config.agent[targetAgent];
        }
        if (config.agent && Object.keys(config.agent).length === 0) {
          delete config.agent;
        }
      }
    }

    const tempPath = `${CONFIG_PATH}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\\n", "utf8");
    fs.renameSync(tempPath, CONFIG_PATH);
  } catch (_) {}
}

export default async function rememberModelPlugin({ client } = {}) {
  if (client?.event?.event) {
    try {
      client.event.event({
        onSseEvent: (streamEvent) => {
          try {
            const data = streamEvent?.data;
            if (!data) return;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (
              parsed?.type === "session.next.model.switched" &&
              parsed.properties?.model
            ) {
              const { id, providerID, variant } = parsed.properties.model;
              updateGlobalConfig({
                providerID,
                modelID: id,
                variant,
                explicitVariant: true,
              });
            }
          } catch (_) {}
        },
      }).catch(() => {});
    } catch (_) {}
  }

  return {
    "chat.message": async (input, output) => {
      try {
        const providerID = input.model?.providerID || output?.message?.model?.providerID;
        const modelID = input.model?.modelID || input.model?.id || output?.message?.model?.modelID;
        const variant = input.variant || output?.message?.model?.variant;
        updateGlobalConfig({
          providerID,
          modelID,
          variant,
          agent: input.agent,
          explicitVariant: true,
        });
      } catch (_) {}
    },
    "chat.params": async (input) => {
      try {
        const providerID = input.provider?.id || input.model?.providerID;
        const modelID = input.model?.id;
        if (providerID && modelID) {
          updateGlobalConfig({
            providerID,
            modelID,
            agent: input.agent,
            explicitVariant: false,
          });
        }
      } catch (_) {}
    },
  };
}
"""


def _validated_gateway_url(value):
    value = (value or "").strip().rstrip("/")
    parsed = urlparse(value)
    local_http = parsed.scheme == "http" and parsed.hostname in (
        "localhost",
        "127.0.0.1",
    )
    if parsed.scheme != "https" and not local_http:
        raise ValueError("gateway URL must use HTTPS (or localhost HTTP)")
    if not parsed.netloc:
        raise ValueError("gateway URL is not a valid origin")
    return value


def _validated_key(value):
    value = (value or "").strip()
    if len(value) < 8 or any(character.isspace() for character in value):
        raise ValueError("the Hub William API key is invalid")
    return value


def _strip_jsonc(text):
    output = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        character = text[index]
        if in_string:
            output.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            output.append(character)
            index += 1
            continue
        if text[index : index + 2] == "//":
            end = text.find("\n", index)
            index = len(text) if end == -1 else end
            continue
        if text[index : index + 2] == "/*":
            end = text.find("*/", index + 2)
            if end == -1:
                raise ValueError("unterminated JSONC comment")
            index = end + 2
            continue
        output.append(character)
        index += 1
    return re.sub(r",\s*([}\]])", r"\1", "".join(output))


def _read_document(path):
    if not os.path.exists(path):
        return {}
    if os.path.islink(path):
        raise ValueError("refusing to replace symlink: %s" % path)
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if not text.strip():
        return {}
    try:
        document = json.loads(_strip_jsonc(text))
    except ValueError as error:
        raise ValueError("cannot update %s: %s" % (path, error))
    if not isinstance(document, dict):
        raise ValueError("cannot update %s: expected a JSON object" % path)
    return document


def _atomic_write(path, text):
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    if os.path.isfile(path):
        backup = path + ".hub-william.bak"
        if not os.path.exists(backup):
            shutil.copy2(path, backup)
            os.chmod(backup, 0o600)
    descriptor, temporary = tempfile.mkstemp(prefix=".hub-william-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _gateway_models(gateway_url, key, provider):
    paths = {
        "codex": "/gateway/openai/v1/models",
        "claude": "/gateway/claude/v1/models?limit=1000",
        "gemini": "/gateway/gemini/v1beta/models",
        "deepseek": "/gateway/deepseek/models",
        "grok": "/gateway/grok/v1/models",
    }
    request = Request(
        gateway_url + paths[provider],
        headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=12) as response:
            payload = json.load(response)
    except HTTPError as error:
        try:
            payload = json.load(error)
        except (OSError, ValueError):
            payload = {}
        finally:
            error.close()
        if (
            error.code == 401
            and isinstance(payload, dict)
            and payload.get("code") == "invalid_gateway_key"
        ):
            raise ValueError("the Hub gateway key is invalid or revoked")
        return []
    except (URLError, TimeoutError, ValueError):
        return []
    models = payload.get("data", []) if isinstance(payload, dict) else []
    return [model for model in models if isinstance(model, dict) and model.get("id")]


def _read_rpc_response(process, request_id, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = max(0, deadline - time.monotonic())
        ready, _, _ = select.select([process.stdout], [], [], remaining)
        if not ready:
            break
        line = process.stdout.readline()
        if not line:
            break
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("id") == request_id:
            return message
    return None


def _send_rpc(process, message):
    process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
    process.stdin.flush()


def _codex_models():
    if not shutil.which("codex"):
        return []
    process = None
    try:
        process = subprocess.Popen(
            ["codex", "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        _send_rpc(
            process,
            {
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {"name": "hub-william-opencode", "version": "1"},
                    "capabilities": None,
                },
            },
        )
        if not _read_rpc_response(process, 1):
            return []
        _send_rpc(process, {"method": "initialized"})
        _send_rpc(
            process,
            {
                "method": "model/list",
                "id": 2,
                "params": {"includeHidden": False, "limit": 100},
            },
        )
        response = _read_rpc_response(process, 2)
        data = (response or {}).get("result", {}).get("data", [])
        return [model for model in data if isinstance(model, dict) and model.get("model")]
    except (OSError, ValueError, AttributeError):
        return []
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()


def _variants(efforts):
    return {effort: {"reasoningEffort": effort} for effort in efforts}


def _codex_model_config(available, discovered):
    local = {model["model"]: model for model in discovered}
    fallback = {
        identifier: (name, efforts)
        for identifier, name, efforts in DEFAULT_CODEX_MODELS
    }
    models = {}
    for model in available:
        identifier = model["id"]
        if identifier in models:
            continue
        local_model = local.get(identifier, {})
        efforts = [
            item.get("reasoningEffort")
            for item in local_model.get("supportedReasoningEfforts", [])
            if isinstance(item, dict) and item.get("reasoningEffort")
        ]
        if not efforts and identifier in fallback:
            efforts = fallback[identifier][1]
        entry = {
            "name": local_model.get("displayName")
            or model.get("display_name")
            or model.get("name")
            or fallback.get(identifier, (identifier,))[0],
        }
        if efforts:
            entry["options"] = {
                "reasoningEffort": "medium" if "medium" in efforts else efforts[0]
            }
            entry["variants"] = _variants(efforts)
        models[identifier] = entry
    return models


def _provider_model_config(models, effort_option=None):
    configured = {}
    for model in models:
        identifier = model["id"]
        entry = {"name": model.get("display_name") or model.get("name") or identifier}
        effort_capability = (model.get("capabilities") or {}).get("effort") or {}
        efforts = [
            name
            for name, support in effort_capability.items()
            if name != "supported"
            and isinstance(support, dict)
            and support.get("supported")
        ]
        if effort_option and efforts:
            default = "medium" if "medium" in efforts else efforts[0]
            entry["options"] = {effort_option: default}
            entry["variants"] = {
                effort: {effort_option: effort} for effort in efforts
            }
        configured[identifier] = entry
    return configured


def _missing_managed_model(value, managed_ids, providers):
    if not isinstance(value, str) or "/" not in value:
        return False
    provider_id, model_id = value.split("/", 1)
    return provider_id in managed_ids and (
        provider_id not in providers or model_id not in providers[provider_id]["models"]
    )


def build_config(existing, gateway_url, key, catalogues, plugin_path=None):
    document = copy.deepcopy(existing) if isinstance(existing, dict) else {}
    document["$schema"] = "https://opencode.ai/config.json"
    disabled = document.get("disabled_providers")
    if not isinstance(disabled, list):
        disabled = []
    document["disabled_providers"] = list(dict.fromkeys(disabled + ["opencode"]))
    providers = document.get("provider")
    if not isinstance(providers, dict):
        providers = {}
    document["provider"] = providers

    plugins = []
    if plugin_path:
        plugins.append("file://" + plugin_path)
    if isinstance(existing, dict) and isinstance(existing.get("plugin"), list):
        for item in existing["plugin"]:
            if item not in plugins:
                plugins.append(item)
    if plugins:
        document["plugin"] = plugins

    provider_specs = {
        "hub-codex": {
            "name": "Hub William · Codex",
            "npm": "@ai-sdk/openai",
            "options": {
                "apiKey": key,
                "baseURL": gateway_url + "/gateway/openai/v1",
            },
            "models": _codex_model_config(
                catalogues.get("codex", []), catalogues.get("codex_metadata", [])
            ),
        },
        "hub-claude": {
            "name": "Hub William · Claude",
            "npm": "@ai-sdk/anthropic",
            "options": {
                "authToken": key,
                "baseURL": gateway_url + "/gateway/claude/v1",
            },
            "models": _provider_model_config(catalogues.get("claude", []), effort_option="effort"),
        },
        "hub-gemini": {
            "name": "Hub William · Gemini / AGY",
            "npm": "@ai-sdk/google",
            "options": {
                "apiKey": "hub-william",
                "baseURL": gateway_url + "/gateway/gemini/v1beta",
                "headers": {"Authorization": "Bearer " + key},
            },
            "models": _provider_model_config(catalogues.get("gemini", [])),
        },
        "hub-grok": {
            "name": "Hub William · Grok",
            "npm": "@ai-sdk/openai",
            "options": {
                "apiKey": key,
                "baseURL": gateway_url + "/gateway/grok/v1",
            },
            "models": _provider_model_config(
                catalogues.get("grok", []) or DEFAULT_GROK_MODELS
            ),
        },
        "hub-deepseek": {
            "name": "Hub William · DeepSeek",
            "npm": "@ai-sdk/openai",
            "options": {
                "apiKey": key,
                "baseURL": gateway_url + "/gateway/deepseek",
            },
            "models": _provider_model_config(catalogues.get("deepseek", [])),
        },
    }
    for provider_id in provider_specs:
        providers.pop(provider_id, None)
    for provider_id, provider in provider_specs.items():
        if provider["models"]:
            providers[provider_id] = provider
    for model_key in ("model", "small_model"):
        if _missing_managed_model(document.get(model_key), provider_specs, providers):
            document.pop(model_key, None)
    if isinstance(document.get("agent"), dict):
        for settings in document["agent"].values():
            if isinstance(settings, dict) and _missing_managed_model(
                settings.get("model"), provider_specs, providers
            ):
                settings.pop("model", None)
                settings.pop("variant", None)
    if "model" not in document:
        if "hub-codex" in providers:
            preferred = "gpt-5.6-sol"
            if preferred not in providers["hub-codex"]["models"]:
                preferred = next(iter(providers["hub-codex"]["models"]))
            document["model"] = "hub-codex/" + preferred
        elif "hub-claude" in providers:
            preferred = "claude-opus-5"
            if preferred not in providers["hub-claude"]["models"]:
                preferred = "claude-sonnet-5"
            if preferred not in providers["hub-claude"]["models"]:
                preferred = next(iter(providers["hub-claude"]["models"]))
            document["model"] = "hub-claude/" + preferred
    return document


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Install live Hub William providers and models into OpenCode."
    )
    parser.add_argument("--key", metavar="KEY", help="Hub gateway key; omit for hidden input")
    parser.add_argument(
        "--url", metavar="ORIGIN", help="gateway origin; defaults to HUB_WILLIAM_GATEWAY_URL"
    )
    return parser.parse_args(argv)


def install(terminal, args, home=None):
    gateway_url = _validated_gateway_url(
        args.url or os.environ.get("HUB_WILLIAM_GATEWAY_URL")
    )
    key = _validated_key(args.key) if args.key is not None else _validated_key(
        getpass.getpass("Hub William gateway key: ", stream=terminal)
    )
    terminal.write("Discovering models from connected Hub pools…\n")
    terminal.flush()
    catalogues = {
        "codex": _gateway_models(gateway_url, key, "codex"),
        "claude": _gateway_models(gateway_url, key, "claude"),
        "gemini": _gateway_models(gateway_url, key, "gemini"),
        "grok": _gateway_models(gateway_url, key, "grok"),
        "deepseek": _gateway_models(gateway_url, key, "deepseek"),
    }
    if not any(catalogues.values()):
        raise ValueError("no provider models could be discovered; check the key and gateway")
    catalogues["codex_metadata"] = _codex_models() if catalogues["codex"] else []
    config_dir = os.path.join(
        home or os.path.expanduser("~"), ".config", "opencode"
    )
    path = os.path.join(config_dir, "opencode.json")
    plugin_path = os.path.join(config_dir, "plugins", "remember-model.mjs")
    existing = _read_document(path)
    document = build_config(
        existing, gateway_url, key, catalogues, plugin_path=plugin_path
    )
    if not document.get("provider"):
        raise ValueError("the key has no reachable provider pools")
    _atomic_write(plugin_path, REMEMBER_MODEL_PLUGIN_SOURCE)
    _atomic_write(path, json.dumps(document, indent=2, sort_keys=True) + "\n")
    installed = ", ".join(sorted(document["provider"]))
    terminal.write("Installed OpenCode providers: %s.\n" % installed)
    terminal.write(
        "Installed OpenCode plugin: remember-model (auto-saves selected model).\n"
    )
    terminal.write("Run opencode, use /models to switch models and /variants for effort.\n")
    terminal.flush()
    return 0


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if args.key is not None:
            return install(sys.stderr, args)
        with open("/dev/tty", "r+", buffering=1) as terminal:
            return install(terminal, args)
    except (OSError, ValueError) as error:
        sys.stderr.write("OpenCode installer: %s\n" % error)
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("\nOpenCode installation cancelled.\n")
        return 130


if __name__ == "__main__":
    sys.exit(main())
