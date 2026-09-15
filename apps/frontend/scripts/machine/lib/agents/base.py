"""What every agent adapter has to answer.

Each harness stores skills, MCP registrations and its always-on markdown in a
different place and a different file format. The reconciler in sync.py only
ever talks to this interface.
"""

import hashlib
import os
import subprocess

from .. import atomic, paths, probe, tomlfile


class AgentConfigError(Exception):
    """The agent's own config file is not something we dare rewrite."""


def hash_text(text):
    normalised = "\n".join(line.rstrip() for line in (text or "").strip().splitlines())
    return "sha256:" + hashlib.sha256(normalised.encode("utf-8")).hexdigest()


class Agent(object):
    name = ""
    label = ""
    cli = ""
    harness_filename = "AGENTS.md"

    # -- locations --------------------------------------------------------
    def home_dir(self):
        return os.path.join(paths.home(), "." + self.name)

    def skills_dir(self):
        return os.path.join(self.home_dir(), "skills")

    def harness_path(self):
        return os.path.join(self.home_dir(), self.harness_filename)

    def mcp_config_path(self):
        raise NotImplementedError

    # -- probing ----------------------------------------------------------
    def cli_path(self):
        return probe.which(self.cli)

    def available(self):
        return self.cli_path() is not None

    # -- mcp --------------------------------------------------------------
    def render_mcp(self, spec):
        """Catalog spec -> the mapping this agent's config wants."""
        raise NotImplementedError

    def mcp_get(self, name):
        """(stored mapping or None, fingerprint of what is on disk or None)."""
        raise NotImplementedError

    def mcp_upsert(self, name, spec):
        """Write the block. Returns (changed, fingerprint)."""
        raise NotImplementedError

    def mcp_remove(self, name):
        """Delete the block. Returns True when something was removed."""
        raise NotImplementedError

    def mcp_names(self):
        raise NotImplementedError

    def desired_mcp_fingerprint(self, name, spec):
        raise NotImplementedError

    def mcp_matches(self, stored, spec):
        """True when what is already registered means the same thing.

        Used to leave a server the user configured themselves alone instead of
        rewriting it to say the same thing in our words.
        """
        if not isinstance(stored, dict):
            return False
        if "url" in spec:
            if stored.get("url") != spec["url"]:
                return False
        else:
            if stored.get("command") != spec.get("command"):
                return False
            if list(stored.get("args") or []) != list(spec.get("args") or []):
                return False
        return dict(stored.get("env") or {}) == dict(spec.get("env") or {})

    # -- auth -------------------------------------------------------------
    def auth_plan(self, name):
        """('run', argv) to execute, or ('manual', [lines]) to print."""
        return ("manual", ["Open %s and authenticate %s." % (self.cli, name)])

    def has_credentials(self, name, url=None):
        """True when a token for `name` is already stored. None = unknown."""
        return None

    # -- plugins ----------------------------------------------------------
    def plugin_install(self, plugin):
        return None

    # -- helpers ----------------------------------------------------------
    def run(self, argv, capture=True):
        try:
            if capture:
                completed = subprocess.run(
                    argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    universal_newlines=True,
                )
                return completed.returncode, completed.stdout or ""
            completed = subprocess.run(argv)
            return completed.returncode, ""
        except OSError as exc:
            return 127, str(exc)

    def __repr__(self):
        return "<Agent %s>" % self.name


class TomlMcpAgent(Agent):
    """Codex and Grok both keep MCP servers in a `[mcp_servers.<name>]` table.

    Edits are line-surgical: the block is replaced or dropped and every other
    byte of the file is copied through, so trust levels, hook hashes and the
    user's own comments survive.
    """

    mcp_table = ("mcp_servers",)

    def _text(self):
        return atomic.read_text(self.mcp_config_path(), default="") or ""

    def _table_path(self, name):
        return self.mcp_table + (name,)

    def _guard(self, text):
        try:
            return tomlfile.loads(text)
        except tomlfile.TomlError as exc:
            raise AgentConfigError(
                "cannot parse %s (%s); leaving it alone"
                % (paths.tilde(self.mcp_config_path()), exc)
            )

    def desired_block(self, name, spec):
        return tomlfile.render_table(
            self._table_path(name), self.render_mcp(spec), marker="mcp " + name
        )

    def desired_mcp_fingerprint(self, name, spec):
        return hash_text(self.desired_block(name, spec))

    def mcp_get(self, name):
        text = self._text()
        document = self._guard(text)
        table = document.find(self._table_path(name))
        if table is None:
            return None, None
        block = tomlfile.table_text(text, self._table_path(name))
        return document.get(self._table_path(name)), hash_text(block)

    def mcp_names(self):
        document = self._guard(self._text())
        stored = document.get(self.mcp_table, {}) or {}
        return sorted(stored.keys()) if isinstance(stored, dict) else []

    def mcp_upsert(self, name, spec):
        text = self._text()
        self._guard(text)
        updated = tomlfile.upsert_table(
            text, self._table_path(name), self.render_mcp(spec), marker="mcp " + name
        )
        changed = updated != text
        if changed:
            atomic.atomic_write_text(self.mcp_config_path(), updated)
        block = tomlfile.table_text(updated, self._table_path(name))
        return changed, hash_text(block)

    def mcp_remove(self, name):
        text = self._text()
        self._guard(text)
        updated = tomlfile.remove_table(text, self._table_path(name))
        if updated == text:
            return False
        atomic.atomic_write_text(self.mcp_config_path(), updated)
        return True
