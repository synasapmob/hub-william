"""Codex CLI.

`~/.codex/config.toml` also holds trust levels, provider keys and hook hashes,
so it is edited by line span and never re-serialised.
"""

import json
import os

from .. import paths
from .base import TomlMcpAgent


class CodexAgent(TomlMcpAgent):
    name = "codex"
    label = "Codex"
    cli = "codex"
    harness_filename = "AGENTS.md"

    _auth_cache = None

    def mcp_config_path(self):
        return os.path.join(paths.home(), ".codex", "config.toml")

    def render_mcp(self, spec):
        if "url" in spec:
            out = {"url": spec["url"]}
        else:
            out = {"command": spec["command"], "args": list(spec.get("args") or [])}
        if spec.get("env"):
            out["env"] = dict(spec["env"])
        return out

    def auth_plan(self, name):
        return ("run", [self.cli, "mcp", "login", name])

    def has_credentials(self, name, url=None):
        """The token is in the keychain and unreadable from here, but whether
        one exists is not a secret: `mcp list --json` carries `auth_status` per
        server, and that is the question `mcp auth` is actually asking."""
        status = self._auth_statuses().get(name)
        if status == "not_logged_in":
            return False
        if status == "o_auth":
            return True
        # `unsupported` is a stdio server, and an unknown name is one Codex has
        # not been told about yet. Neither is a "yes", and neither is a "no".
        return None

    def _auth_statuses(self):
        """`{name: auth_status}`, read once.

        `mcp auth` asks per (server, agent), so without the cache a run with
        four servers shells out four times to learn the same thing. The
        registry hands out one instance per agent, which makes this once a run.
        """
        if self._auth_cache is None:
            self._auth_cache = self._read_auth_statuses()
        return self._auth_cache

    def _read_auth_statuses(self):
        code, out = self.run([self.cli, "mcp", "list", "--json"])
        if code != 0:
            return {}
        try:
            servers = json.loads(out)
        except ValueError:
            return {}
        if not isinstance(servers, list):
            return {}
        return dict(
            (server.get("name"), server.get("auth_status"))
            for server in servers
            if isinstance(server, dict) and server.get("name")
        )

    def plugin_install(self, plugin):
        target = plugin.plugin
        if plugin.marketplace:
            target = "%s@%s" % (plugin.plugin, plugin.marketplace)
        return self.run([self.cli, "plugin", "install", target])
