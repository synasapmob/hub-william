"""Claude Code.

Skills live in `~/.claude/skills/`, the always-on markdown is `~/.claude/CLAUDE.md`,
and user-scope MCP servers are one key inside `~/.claude.json`. That file is
the CLI's live state, so we read it, touch `mcpServers` only, and write it back
with the same indent.
"""

import os
import re

from .. import jsonfile, paths
from .base import Agent, AgentConfigError

# `mcp list` prints one server per line, `<name>: <target> - <state>`.
_LIST_NAME_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*):\s")


class ClaudeAgent(Agent):
    name = "claude"
    label = "Claude Code"
    cli = "claude"
    harness_filename = "CLAUDE.md"

    _auth_cache = None

    def mcp_config_path(self):
        return os.path.join(paths.home(), ".claude.json")

    # -- mcp --------------------------------------------------------------
    def render_mcp(self, spec):
        if "url" in spec:
            out = {"type": "http", "url": spec["url"]}
        else:
            out = {
                "type": "stdio",
                "command": spec["command"],
                "args": list(spec.get("args") or []),
            }
        if spec.get("env"):
            out["env"] = dict(spec["env"])
        return out

    def _read(self):
        try:
            return jsonfile.read(self.mcp_config_path())
        except ValueError as exc:
            raise AgentConfigError(str(exc))

    def mcp_get(self, name):
        data, _ = self._read()
        servers = data.get("mcpServers") or {}
        if name not in servers:
            return None, None
        return servers[name], jsonfile.fingerprint(servers[name])

    def mcp_names(self):
        data, _ = self._read()
        return sorted((data.get("mcpServers") or {}).keys())

    def desired_mcp_fingerprint(self, name, spec):
        return jsonfile.fingerprint(self.render_mcp(spec))

    def mcp_upsert(self, name, spec):
        data, indent = self._read()
        servers = data.setdefault("mcpServers", {})
        block = self.render_mcp(spec)
        changed = servers.get(name) != block
        if changed:
            servers[name] = block
            jsonfile.write(self.mcp_config_path(), data, indent=indent)
        return changed, jsonfile.fingerprint(block)

    def mcp_remove(self, name):
        data, indent = self._read()
        servers = data.get("mcpServers")
        if not servers or name not in servers:
            return False
        del servers[name]
        if not servers:
            del data["mcpServers"]
        jsonfile.write(self.mcp_config_path(), data, indent=indent)
        return True

    # -- auth -------------------------------------------------------------
    def auth_plan(self, name):
        return ("run", [self.cli, "mcp", "login", name])

    def has_credentials(self, name, url=None):
        """Claude keeps MCP tokens in a store this cannot open, but `mcp list`
        connects to every server and reports which ones still need
        authenticating — which is the same question, asked of the CLI instead
        of the filesystem."""
        return self._auth_states().get(name)

    def _auth_states(self):
        """`{name: True | False | None}`, read once.

        `mcp list` health-checks every server, so it is the slowest thing here
        by a distance and `mcp auth` would otherwise call it once per server.
        The registry hands out one instance per agent, making this once a run.
        A login later in the same run only changes that server's own state, and
        each one is asked before its own login, so the cache cannot go stale in
        a way that matters.
        """
        if self._auth_cache is None:
            self._auth_cache = self._read_auth_states()
        return self._auth_cache

    def _read_auth_states(self):
        code, out = self.run([self.cli, "mcp", "list"])
        if code != 0:
            return {}
        states = {}
        current = None
        # The state can wrap onto its own line in a narrow terminal, so the
        # name is remembered rather than assumed to share the line.
        for line in (out or "").splitlines():
            line = line.strip()
            if not line:
                continue
            match = _LIST_NAME_RE.match(line)
            if match:
                current = match.group(1)
                states.setdefault(current, None)
            if current is None:
                continue
            if "Needs authentication" in line:
                states[current] = False
            elif "Connected" in line:
                states[current] = True
        return states

    # -- plugins ----------------------------------------------------------
    def plugin_install(self, plugin):
        if plugin.source:
            code, out = self.run([self.cli, "plugin", "marketplace", "add", plugin.source])
            if code != 0:
                return code, out
        target = plugin.plugin
        if plugin.marketplace:
            target = "%s@%s" % (plugin.plugin, plugin.marketplace)
        return self.run([self.cli, "plugin", "install", target, "--scope", "user"])
