"""A whole machine in a temp directory.

Every test gets its own HOME, its own PATH holding fake agent CLIs, and its
own copy of `machine/` so the repo's real catalog, profile and state are never
touched. Commands run through `install.sh` exactly as a person would run them.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

MACHINE_SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The documents live beside the program, not inside it, so a fixture that only
# copied `machine/` would run the installer against an empty catalogue.
REPO_SRC = os.path.dirname(os.path.dirname(os.path.dirname(MACHINE_SRC)))
DOCUMENT_TREES = ("contributors",)
if MACHINE_SRC not in sys.path:
    sys.path.insert(0, MACHINE_SRC)

from lib import tomlfile  # noqa: E402  (needs the path above)

_IGNORE = shutil.ignore_patterns(
    "__pycache__", "*.pyc", "applied.json", "local.toml", ".lock", "secrets.zsh",
)

FAKE_CLI = """\
#!/bin/sh
printf '%s\\n' "$(basename "$0") $*" >> "$FAKE_LOG"
"""
FAKE_CLI_TAIL = "exit ${FAKE_EXIT:-0}\n"


class Result(object):
    def __init__(self, completed):
        self.code = completed.returncode
        self.out = completed.stdout or ""

    def __contains__(self, needle):
        return needle in self.out

    def line_for(self, *words):
        for line in self.out.splitlines():
            if all(word in line for word in words):
                return line.strip()
        return None

    def __repr__(self):
        return "<exit %d>\n%s" % (self.code, self.out)


class Machine(object):
    def __init__(self, clis=("claude", "codex", "grok", "gh")):
        self.root = tempfile.mkdtemp(prefix="hw-machine-")
        self.home = os.path.join(self.root, "home")
        self.bin = os.path.join(self.root, "bin")
        self.machine = os.path.join(self.root, "frontend", "scripts", "machine")
        os.makedirs(self.home)
        os.makedirs(self.bin)
        shutil.copytree(MACHINE_SRC, self.machine, ignore=_IGNORE)
        for tree in DOCUMENT_TREES:
            source = os.path.join(REPO_SRC, tree)
            if os.path.isdir(source):
                shutil.copytree(
                    source, os.path.join(self.root, tree), ignore=_IGNORE
                )
        os.chmod(os.path.join(self.machine, "install.sh"), 0o755)
        self.calls = os.path.join(self.root, "calls.log")
        for name in clis:
            self.add_cli(name)

    # -- setup ------------------------------------------------------------
    def add_cli(self, name, body=""):
        """A fake CLI on PATH. `body` is extra shell appended after the log
        line, for the few tests that need one to answer rather than just
        record."""
        path = os.path.join(self.bin, name)
        with open(path, "w") as handle:
            handle.write(FAKE_CLI + body + FAKE_CLI_TAIL)
        os.chmod(path, 0o755)
        return path

    def drop_cli(self, name):
        path = os.path.join(self.bin, name)
        if os.path.exists(path):
            os.unlink(path)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)

    # -- running ----------------------------------------------------------
    def run(self, *argv, **kwargs):
        env = dict(os.environ)
        env.update({
            "HOME": self.home,
            "PATH": self.bin + ":/usr/bin:/bin",
            "FAKE_LOG": self.calls,
            "NO_COLOR": "1",
            "HUB_WILLIAM_PYTHON": sys.executable,
        })
        env.pop("HUB_WILLIAM_MACHINE_DIR", None)
        completed = subprocess.run(
            [os.path.join(self.machine, "install.sh")] + [str(a) for a in argv],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, universal_newlines=True, env=env,
            cwd=self.machine,
        )
        return Result(completed)

    def cli_calls(self):
        if not os.path.exists(self.calls):
            return []
        with open(self.calls) as handle:
            return [line.strip() for line in handle if line.strip()]

    # -- paths ------------------------------------------------------------
    def home_path(self, *parts):
        return os.path.join(self.home, *parts)

    def machine_path(self, *parts):
        return os.path.join(self.machine, *parts)

    def catalog(self, *parts):
        """Registries: what the installer registers rather than installs."""
        return os.path.join(self.machine, "registries", *parts)

    def library(self, *parts):
        """A shared document: contributors/default/libraries/<root>/..."""
        return os.path.join(
            self.root, "contributors", "default", "libraries", *parts
        )

    def tool(self, *parts):
        return os.path.join(
            self.root, "contributors", "default", "tools", *parts
        )

    def contributor(self, login, *parts):
        """A contributed document, in the same shape as the shared tree."""
        return os.path.join(self.root, "contributors", login, *parts)

    # -- reading ----------------------------------------------------------
    def read(self, path, default=None):
        if not os.path.isfile(path):
            return default
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def write(self, path, text):
        directory = os.path.dirname(path)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def claude_mcp(self):
        text = self.read(self.home_path(".claude.json"), "{}")
        return (json.loads(text) or {}).get("mcpServers") or {}

    def toml_mcp(self, agent):
        name = ".codex/config.toml" if agent == "codex" else ".grok/config.toml"
        text = self.read(self.home_path(*name.split("/")), "")
        return tomlfile.load_data(text).get("mcp_servers") or {}

    def agent_mcp(self, agent):
        return self.claude_mcp() if agent == "claude" else self.toml_mcp(agent)

    def profile(self):
        text = self.read(self.machine_path("profiles", "local.toml"))
        return tomlfile.load_data(text) if text else None

    def applied(self):
        text = self.read(self.machine_path("state", "applied.json"))
        return json.loads(text) if text else None

    def skill_link(self, agent, name):
        return self.home_path("." + agent, "skills", name)
