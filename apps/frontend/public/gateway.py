#!/usr/bin/env python3
"""Install Hub William as the upstream gateway for supported agent CLIs.

    curl -fsSL https://<hub-william-origin>/gateway.py | python3 - --url=https://<hub-william-origin>/api --key=YOUR_GATEWAY_KEY
"""

import argparse
import getpass
import json
import os
import re
import select
import shutil
import sys
import tempfile
import termios
import tty
from urllib.parse import urlparse


AGENTS = (
    ("codex", "Codex", ".codex/config.toml"),
    ("claude", "Claude Code", ".claude/settings.json"),
    ("grok", "Grok", ".grok/config.toml"),
)
ESCAPE_GRACE = 0.06


def _read_key(fd):
    char = os.read(fd, 1)
    if char == b"\x1b":
        ready, _, _ = select.select([fd], [], [], ESCAPE_GRACE)
        if not ready:
            return "escape"
        if os.read(fd, 1) != b"[":
            return "other"
        return {b"A": "up", b"B": "down"}.get(os.read(fd, 1), "other")
    if char in (b"\r", b"\n"):
        return "enter"
    if char == b" ":
        return "space"
    if char in (b"\x03", b"\x04"):
        return "abort"
    return "other"


def choose_agents(terminal):
    selected = [True] * len(AGENTS)
    cursor = 0
    drawn = 0
    fd = terminal.fileno()
    saved = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd, termios.TCSANOW)
        while True:
            lines = [
                "Hub William gateway installer",
                "",
                "Choose agent CLIs:",
            ]
            for index, (_name, label, _path) in enumerate(AGENTS):
                marker = ">" if index == cursor else " "
                checked = "x" if selected[index] else " "
                detected = "installed" if shutil.which(AGENTS[index][0]) else "not detected"
                lines.append("  %s [%s] %-12s %s" % (marker, checked, label, detected))
            lines.extend(
                [
                    "",
                    "  ↑/↓ move · space toggle · enter install · esc quit",
                ]
            )
            if drawn:
                terminal.write("\033[%dA" % drawn)
            terminal.write("\033[J" + "\n".join(lines) + "\n")
            terminal.flush()
            drawn = len(lines)
            key = _read_key(fd)
            if key == "up":
                cursor = (cursor - 1) % len(AGENTS)
            elif key == "down":
                cursor = (cursor + 1) % len(AGENTS)
            elif key == "space":
                selected[cursor] = not selected[cursor]
            elif key == "enter":
                return [AGENTS[index][0] for index, enabled in enumerate(selected) if enabled]
            elif key == "escape":
                return None
            elif key == "abort":
                raise KeyboardInterrupt
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


def _toml_string(value):
    return json.dumps(value, ensure_ascii=True)


def _upsert_top_level(text, values):
    lines = text.splitlines(True)
    table_start = next(
        (index for index, line in enumerate(lines) if line.lstrip().startswith("[")),
        len(lines),
    )
    for key, value in values.items():
        pattern = re.compile(r"^\s*%s\s*=" % re.escape(key))
        replacement = "%s = %s\n" % (key, _toml_string(value))
        found = next(
            (index for index in range(table_start) if pattern.match(lines[index])),
            None,
        )
        if found is None:
            lines.insert(table_start, replacement)
            table_start += 1
        else:
            lines[found] = replacement
    return "".join(lines)


def _upsert_toml_table(text, table, values):
    lines = text.splitlines(True)
    header = "[%s]" % table
    start = next(
        (index for index, line in enumerate(lines) if line.strip() == header),
        None,
    )
    if start is None:
        if text and not text.endswith("\n"):
            lines.append("\n")
        if lines and lines[-1].strip():
            lines.append("\n")
        lines.append(header + "\n")
        start = len(lines) - 1
        end = len(lines)
    else:
        end = next(
            (
                index
                for index in range(start + 1, len(lines))
                if lines[index].lstrip().startswith("[")
            ),
            len(lines),
        )
    for key, value in values.items():
        pattern = re.compile(r"^\s*%s\s*=" % re.escape(key))
        replacement = "%s = %s\n" % (key, _toml_string(value))
        found = next(
            (index for index in range(start + 1, end) if pattern.match(lines[index])),
            None,
        )
        if found is None:
            lines.insert(end, replacement)
            end += 1
        else:
            lines[found] = replacement
    return "".join(lines)


def _read_text(path):
    if not os.path.exists(path):
        return ""
    if os.path.islink(path):
        raise ValueError("refusing to replace symlink: %s" % path)
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _read_json(path):
    text = _read_text(path)
    if not text.strip():
        return {}
    try:
        value = json.loads(text)
    except ValueError as error:
        raise ValueError("cannot update %s: %s" % (path, error))
    if not isinstance(value, dict):
        raise ValueError("cannot update %s: expected a JSON object" % path)
    return value


def build_changes(home, key, gateway_url, agents):
    changes = {}
    if "codex" in agents:
        path = os.path.join(home, ".codex", "config.toml")
        text = _upsert_top_level(_read_text(path), {"model_provider": "hub-william"})
        changes[path] = _upsert_toml_table(
            text,
            "model_providers.hub-william",
            {
                "name": "Hub William",
                "base_url": gateway_url + "/gateway/openai/v1",
                "experimental_bearer_token": key,
                "wire_api": "responses",
            },
        )
    if "claude" in agents:
        path = os.path.join(home, ".claude", "settings.json")
        document = _read_json(path)
        environment = document.setdefault("env", {})
        if not isinstance(environment, dict):
            raise ValueError("cannot update %s: env must be a JSON object" % path)
        environment["ANTHROPIC_BASE_URL"] = gateway_url + "/gateway/claude"
        environment["ANTHROPIC_AUTH_TOKEN"] = key
        changes[path] = json.dumps(document, indent=2, sort_keys=True) + "\n"
    if "grok" in agents:
        path = os.path.join(home, ".grok", "config.toml")
        text = _read_text(path)
        base_url = gateway_url + "/gateway/grok/v1"
        text = _upsert_toml_table(text, "endpoints", {"models_base_url": base_url})
        changes[path] = _upsert_toml_table(
            text,
            "model.grok-build",
            {"base_url": base_url, "api_key": key},
        )
    return changes


def _atomic_write(path, text):
    directory = os.path.dirname(path)
    if not os.path.isdir(directory):
        os.makedirs(directory, mode=0o700)
    if os.path.isfile(path):
        backup = path + ".hub-william.bak"
        if not os.path.exists(backup):
            shutil.copy2(path, backup)
            os.chmod(backup, 0o600)
    fd, temporary = tempfile.mkstemp(prefix=".hub-william-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _validated_gateway_url(value):
    value = (value or "").strip().rstrip("/")
    parsed = urlparse(value)
    local_http = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")
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


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Point Codex, Claude Code, and Grok at a Hub William gateway key.",
    )
    parser.add_argument(
        "--key",
        metavar="KEY",
        help="gateway API key; omit to type it hidden after choosing agents",
    )
    parser.add_argument(
        "--url",
        metavar="ORIGIN",
        help="gateway origin; defaults to HUB_WILLIAM_GATEWAY_URL",
    )
    return parser.parse_args(argv)


def install(terminal, args):
    gateway_url = _validated_gateway_url(
        args.url or os.environ.get("HUB_WILLIAM_GATEWAY_URL")
    )
    key = _validated_key(args.key) if args.key is not None else None
    agents = choose_agents(terminal)
    if agents is None:
        terminal.write("\nNothing changed.\n")
        terminal.flush()
        return 0
    if not agents:
        terminal.write("\nSelect at least one agent. Nothing changed.\n")
        terminal.flush()
        return 0

    if key is None:
        key = _validated_key(
            getpass.getpass("Hub William API key: ", stream=terminal)
        )
    changes = build_changes(os.path.expanduser("~"), key, gateway_url, agents)
    for path, text in changes.items():
        _atomic_write(path, text)
    terminal.write("\nInstalled Hub William gateway for %s.\n" % ", ".join(agents))
    terminal.write("Restart the selected agent CLIs to load the new gateway.\n")
    terminal.flush()
    return 0


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        with open("/dev/tty", "r+", buffering=1) as terminal:
            return install(terminal, args)
    except (OSError, ValueError) as error:
        sys.stderr.write("gateway installer: %s\n" % error)
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("\nGateway installation cancelled.\n")
        return 130


if __name__ == "__main__":
    sys.exit(main())
