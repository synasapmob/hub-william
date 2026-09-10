"""Grok CLI.

Two Grok-specific facts drive this adapter:

*   its MCP blocks carry `enabled = true`; without it the server is registered
    but off;
*   it reads `~/.claude/skills` as well as its own, so when Grok's skill
    selection differs from Claude's we set `compat.claude.skills = false` and
    install into `~/.grok/skills` only. Otherwise Claude's extra skills leak in.
"""

import json
import os

from .. import atomic, paths, tomlfile
from .base import TomlMcpAgent, hash_text

COMPAT_TABLE = ("compat", "claude")


class GrokAgent(TomlMcpAgent):
    name = "grok"
    label = "Grok"
    cli = "grok"
    harness_filename = "AGENTS.md"

    def mcp_config_path(self):
        return os.path.join(paths.home(), ".grok", "config.toml")

    def credentials_path(self):
        return os.path.join(paths.home(), ".grok", "mcp_credentials.json")

    def render_mcp(self, spec):
        if "url" in spec:
            out = {"url": spec["url"]}
        else:
            out = {"command": spec["command"], "args": list(spec.get("args") or [])}
        if spec.get("env"):
            out["env"] = dict(spec["env"])
        out["enabled"] = True
        return out

    def mcp_matches(self, stored, spec):
        if not TomlMcpAgent.mcp_matches(self, stored, spec):
            return False
        # Registered but switched off is not the same as installed.
        return stored.get("enabled", True) is not False

    # -- claude skills compatibility --------------------------------------
    def compat_state(self):
        text = self._text()
        document = self._guard(text)
        table = document.find(COMPAT_TABLE)
        if table is None:
            return None, None
        block = tomlfile.table_text(text, COMPAT_TABLE)
        value = document.get(COMPAT_TABLE + ("skills",))
        return value, hash_text(block)

    def set_claude_skills_compat(self, enabled):
        """Write `[compat.claude] skills = <enabled>`. Returns (changed, fingerprint)."""
        text = self._text()
        self._guard(text)
        updated = tomlfile.upsert_table(
            text, COMPAT_TABLE, {"skills": bool(enabled)},
            marker="grok reads ~/.claude/skills unless this is false",
        )
        changed = updated != text
        if changed:
            atomic.atomic_write_text(self.mcp_config_path(), updated)
        return changed, hash_text(tomlfile.table_text(updated, COMPAT_TABLE))

    def clear_claude_skills_compat(self):
        text = self._text()
        self._guard(text)
        updated = tomlfile.remove_table(text, COMPAT_TABLE)
        if updated == text:
            return False
        atomic.atomic_write_text(self.mcp_config_path(), updated)
        return True

    # -- auth -------------------------------------------------------------
    def auth_plan(self, name):
        # `grok mcp` has no login verb and `grok login` signs into Grok itself,
        # so there is no command to offer — only somewhere to send you.
        return ("manual", [
            "no login command: open grok, run /mcps, select %s, press i" % name,
        ])

    def has_credentials(self, name, url=None):
        text = atomic.read_text(self.credentials_path())
        if text is None or not text.strip():
            return False
        try:
            stored = json.loads(text)
        except ValueError:
            return None
        if not isinstance(stored, dict):
            return None
        # Keyed `<server>:<url>`, and grok only reads the key that matches the
        # server it is starting. Answering "yes, there is a token" because
        # some *other* name holds one for the same URL is how you end up
        # authenticating a server and being asked to authenticate it again.
        for key in stored:
            server, _sep, stored_url = key.partition(":")
            if server != name:
                continue
            if url is None or stored_url == url:
                return True
        return False
