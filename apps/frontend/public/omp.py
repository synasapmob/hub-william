#!/usr/bin/env python3
"""Install live Hub William provider catalogues into OMP.

    curl -fsSL https://<hub>/omp.py | python3 - --url=https://<api>
"""

import argparse
import getpass
import json
import os
import re
import shutil
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


BEGIN = "  # hub-william: providers begin"
END = "  # hub-william: providers end"
PROVIDER_IDS = (
    "hub-codex",
    "hub-claude",
    "hub-gemini",
    "hub-grok",
    "hub-deepseek",
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


def _models_path(home=None):
    if home is not None:
        agent_directory = os.path.join(home, ".omp", "agent")
    else:
        agent_directory = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(
            os.path.expanduser("~"), ".omp", "agent"
        )
    yaml_path = os.path.join(agent_directory, "models.yaml")
    yml_path = os.path.join(agent_directory, "models.yml")
    if os.path.exists(yml_path) or not os.path.exists(yaml_path):
        return yml_path
    return yaml_path


def _read_document(path):
    if not os.path.exists(path):
        legacy = os.path.join(os.path.dirname(path), "models.json")
        if os.path.exists(legacy):
            raise ValueError(
                "OMP has a legacy models.json; run `omp models` once to migrate it, then rerun this installer"
            )
        return ""
    if os.path.islink(path):
        raise ValueError("refusing to replace symlink: %s" % path)
    with open(path, encoding="utf-8") as handle:
        return handle.read()


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


def _yaml_string(value):
    return json.dumps(str(value), ensure_ascii=False)


def _model_lines(models):
    output = []
    seen = set()
    for model in models:
        identifier = str(model.get("id") or "").strip()
        if not identifier or identifier in seen:
            continue
        seen.add(identifier)
        name = model.get("display_name") or model.get("name") or identifier
        output.extend(
            [
                "      - id: %s\n" % _yaml_string(identifier),
                "        name: %s\n" % _yaml_string(name),
            ]
        )
    return output


def _render_provider(provider_id, base_url, api, key, models):
    lines = [
        "  %s:\n" % provider_id,
        "    baseUrl: %s\n" % _yaml_string(base_url),
        "    apiKey: %s\n" % _yaml_string(key),
        "    authHeader: true\n",
        "    api: %s\n" % _yaml_string(api),
        "    models:\n",
    ]
    lines.extend(_model_lines(models))
    return lines


def _render_managed_providers(gateway_url, key, catalogues):
    specs = (
        (
            "hub-codex",
            gateway_url + "/gateway/openai/v1",
            "openai-responses",
            catalogues.get("codex", []),
        ),
        (
            "hub-claude",
            gateway_url + "/gateway/claude",
            "anthropic-messages",
            catalogues.get("claude", []),
        ),
        (
            "hub-gemini",
            gateway_url + "/gateway/gemini/v1beta",
            "google-generative-ai",
            catalogues.get("gemini", []),
        ),
        (
            "hub-grok",
            gateway_url + "/gateway/grok/v1",
            "openai-responses",
            catalogues.get("grok", []),
        ),
        (
            "hub-deepseek",
            gateway_url + "/gateway/deepseek",
            "openai-responses",
            catalogues.get("deepseek", []),
        ),
    )
    lines = [BEGIN + "\n"]
    installed = []
    for provider_id, base_url, api, models in specs:
        if not models:
            continue
        installed.append(provider_id)
        lines.extend(_render_provider(provider_id, base_url, api, key, models))
    lines.append(END + "\n")
    return "".join(lines), installed


def _inject_managed_providers(text, managed):
    lines = text.splitlines(True)
    begin = [index for index, line in enumerate(lines) if line.rstrip("\r\n") == BEGIN]
    end = [index for index, line in enumerate(lines) if line.rstrip("\r\n") == END]
    providers = [
        index
        for index, line in enumerate(lines)
        if re.match(r"^providers:\s*(?:#.*)?(?:\r?\n)?$", line)
    ]
    if len(providers) > 1:
        raise ValueError("models.yml has more than one root providers mapping")
    if not providers:
        if begin or end:
            raise ValueError("models.yml has Hub William markers outside providers")
        meaningful = [
            line
            for line in lines
            if line.strip() and not line.lstrip().startswith("#")
        ]
        if meaningful:
            raise ValueError("models.yml must contain OMP's root `providers:` mapping")
        prefix = text
        if prefix and not prefix.endswith("\n"):
            prefix += "\n"
        return prefix + "providers:\n" + managed

    provider_line = providers[0]
    block_end = len(lines)
    for index in range(provider_line + 1, len(lines)):
        line = lines[index]
        if line.strip() and not line[0].isspace() and not line.lstrip().startswith("#"):
            block_end = index
            break
    indentation = [
        len(line) - len(line.lstrip(" "))
        for line in lines[provider_line + 1 : block_end]
        if line.strip() and not line.lstrip().startswith("#") and line[0] == " "
    ]
    provider_indent = min(indentation) if indentation else 2
    if provider_indent < 1:
        raise ValueError("models.yml has invalid provider indentation")
    delta = provider_indent - 2
    managed_lines = []
    for line in managed.splitlines(True):
        if line.rstrip("\r\n") in (BEGIN, END):
            managed_lines.append(line)
        elif delta >= 0:
            managed_lines.append(" " * delta + line)
        else:
            managed_lines.append(line[-delta:])
    if begin or end:
        if (
            len(begin) != 1
            or len(end) != 1
            or not provider_line < begin[0] < end[0] < block_end
        ):
            raise ValueError("models.yml has ambiguous Hub William provider markers")
        unmanaged = lines[provider_line + 1 : begin[0]] + lines[end[0] + 1 : block_end]
    else:
        unmanaged = lines[provider_line + 1 : block_end]
    for line in unmanaged:
        if not line[:1].isspace() or line.lstrip().startswith("#") or ":" not in line:
            continue
        provider_id = line.strip().split(":", 1)[0].strip("'\"")
        if provider_id in PROVIDER_IDS:
            raise ValueError(
                "models.yml already defines %s outside Hub William's managed block"
                % provider_id
            )
    if begin:
        return "".join(lines[: begin[0]] + managed_lines + lines[end[0] + 1 :])
    before = "".join(lines[:block_end])
    if before and not before.endswith("\n"):
        before += "\n"
    if before and before.splitlines()[-1].strip():
        before += "\n"
    return before + "".join(managed_lines) + "".join(lines[block_end:])


def build_document(existing, gateway_url, key, catalogues):
    managed, installed = _render_managed_providers(
        gateway_url, key, catalogues
    )
    if not installed:
        raise ValueError("the key has no reachable provider pools")
    return _inject_managed_providers(existing, managed), installed


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Install live Hub William providers and models into OMP."
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
    path = _models_path(home)
    existing = _read_document(path)
    document, installed = build_document(existing, gateway_url, key, catalogues)
    _atomic_write(path, document)
    terminal.write("Installed OMP providers: %s.\n" % ", ".join(installed))
    terminal.write("Run omp and use /model to switch provider or model.\n")
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
        sys.stderr.write("OMP installer: %s\n" % error)
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("\nOMP installation cancelled.\n")
        return 130


if __name__ == "__main__":
    sys.exit(main())
