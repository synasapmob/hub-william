#!/usr/bin/env python3
"""Install a live Hub William provider catalogue into OpenCode.

    curl -fsSL https://<hub>/opencode.py | python3 - --url=https://<api> --key=YOUR_GATEWAY_KEY
"""

import argparse
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
    except (HTTPError, URLError, TimeoutError, ValueError):
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


def _codex_model_config(discovered):
    if discovered is None:
        return {}
    models = {}
    for model in discovered:
        identifier = model["model"]
        efforts = [
            item.get("reasoningEffort")
            for item in model.get("supportedReasoningEfforts", [])
            if isinstance(item, dict) and item.get("reasoningEffort")
        ]
        models[identifier] = {
            "name": model.get("displayName") or identifier,
            "options": {"reasoningEffort": "medium"},
            "variants": _variants(efforts or ("low", "medium", "high")),
        }
    if models:
        return models
    return {
        identifier: {
            "name": name,
            "options": {"reasoningEffort": "medium"},
            "variants": _variants(efforts),
        }
        for identifier, name, efforts in DEFAULT_CODEX_MODELS
    }


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


def build_config(existing, gateway_url, key, catalogues):
    document = dict(existing)
    providers = document.get("provider")
    if not isinstance(providers, dict):
        providers = {}
        document["provider"] = providers

    provider_specs = {
        "hub-codex": {
            "name": "Hub William · Codex",
            "npm": "@ai-sdk/openai",
            "options": {
                "apiKey": key,
                "baseURL": gateway_url + "/gateway/openai/v1",
            },
            "models": _codex_model_config(catalogues.get("codex", [])),
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
            "models": _provider_model_config(catalogues.get("grok", [])),
        },
        "hub-deepseek": {
            "name": "Hub William · DeepSeek",
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "apiKey": key,
                "baseURL": gateway_url + "/gateway/deepseek",
            },
            "models": _provider_model_config(catalogues.get("deepseek", [])),
        },
    }
    for provider_id, provider in provider_specs.items():
        if provider["models"]:
            providers[provider_id] = provider
        else:
            providers.pop(provider_id, None)

    disabled = document.get("disabled_providers")
    if not isinstance(disabled, list):
        disabled = []
    if "opencode" not in disabled:
        disabled.append("opencode")
    document["disabled_providers"] = disabled
    if "model" not in document and "hub-codex" in providers:
        preferred = "gpt-5.6-sol"
        if preferred not in providers["hub-codex"]["models"]:
            preferred = next(iter(providers["hub-codex"]["models"]))
        document["model"] = "hub-codex/" + preferred
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
    codex_available = _gateway_models(gateway_url, key, "codex")
    catalogues = {
        "codex": _codex_models() if codex_available else None,
        "claude": _gateway_models(gateway_url, key, "claude"),
        "gemini": _gateway_models(gateway_url, key, "gemini"),
        "grok": _gateway_models(gateway_url, key, "grok"),
        "deepseek": _gateway_models(gateway_url, key, "deepseek"),
    }
    path = os.path.join(
        home or os.path.expanduser("~"), ".config", "opencode", "opencode.json"
    )
    document = build_config(_read_document(path), gateway_url, key, catalogues)
    if not document.get("provider"):
        raise ValueError("the key has no reachable provider pools")
    _atomic_write(path, json.dumps(document, indent=2, sort_keys=True) + "\n")
    installed = ", ".join(sorted(document["provider"]))
    terminal.write("Installed OpenCode providers: %s.\n" % installed)
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
