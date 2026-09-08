"""Allow / deny: what each agent on this machine wants.

Three layers decide whether an item is installed (see the plan):

    catalog   the package *has* it
    profile   this agent *wants* or *refuses* it     <- this file
    disk      what is actually installed

`init` writes both lists, so unchecked means denied, not undecided. A deny is
sticky: a global add or a `sync` will never lift it. Only naming the agent
does — `./install.sh skill add B --agent codex`.
"""

import os

from . import atomic, paths, tomlfile
from .agents import AGENT_NAMES

KINDS = ("skills", "mcp")
_KIND_ALIASES = {"skill": "skills", "skills": "skills", "mcp": "mcp", "mcps": "mcp"}

HEADER = """\
# machine/profiles/local.toml — this machine's answer to the catalog.
# Written by `./install.sh init`. Hand edits are honoured; run `sync` after.
#
#   *_allow   install this for the agent
#   *_deny    never install it, even when the catalog re-adds the name.
#             Lifted only by an agent-scoped add, e.g.
#             `./install.sh skill add B --agent codex`.
#
# A name in neither list is undecided: `status` and `sync` report it and do
# nothing until you decide. `sync --adopt` allows every undecided item.
#
# [shared] is the whole machine. A zsh fragment is loaded by the shell, which
# has no idea which agent started it, so those get one switch rather than one
# per agent.
"""


def normalise_kind(kind):
    try:
        return _KIND_ALIASES[kind]
    except KeyError:
        raise ValueError("unknown kind %r" % kind)


class AgentProfile(object):
    def __init__(self, name, data=None):
        data = data or {}
        self.name = name
        self.harness = bool(data.get("harness", True))
        self.lists = {}
        for kind in KINDS:
            self.lists[(kind, "allow")] = _names(data.get(kind + "_allow"))
            self.lists[(kind, "deny")] = _names(data.get(kind + "_deny"))

    def allow_list(self, kind):
        return self.lists[(normalise_kind(kind), "allow")]

    def deny_list(self, kind):
        return self.lists[(normalise_kind(kind), "deny")]

    def is_denied(self, kind, name):
        return name in self.deny_list(kind)

    def is_allowed(self, kind, name):
        return name in self.allow_list(kind) and not self.is_denied(kind, name)

    def is_undecided(self, kind, name):
        return not (name in self.allow_list(kind) or self.is_denied(kind, name))

    def allow(self, kind, name):
        """Want it. Clears any deny — callers gate this on an explicit --agent."""
        kind = normalise_kind(kind)
        _discard(self.lists[(kind, "deny")], name)
        _add(self.lists[(kind, "allow")], name)

    def deny(self, kind, name):
        kind = normalise_kind(kind)
        _discard(self.lists[(kind, "allow")], name)
        _add(self.lists[(kind, "deny")], name)

    def unset(self, kind, name):
        """Drop from allow, leave any deny alone. This is what a global remove
        does: it uninstalls without inventing a refusal the operator never made."""
        kind = normalise_kind(kind)
        _discard(self.lists[(kind, "allow")], name)

    def forget(self, kind, name):
        kind = normalise_kind(kind)
        _discard(self.lists[(kind, "allow")], name)
        _discard(self.lists[(kind, "deny")], name)

    def to_toml_map(self):
        out = {"harness": self.harness}
        for kind in KINDS:
            out[kind + "_allow"] = sorted(self.lists[(kind, "allow")])
            out[kind + "_deny"] = sorted(self.lists[(kind, "deny")])
        return out


class Profile(object):
    def __init__(self, agents=None, shared=None, source="empty", legacy_shell=False,
                 contributor="default"):
        self.agents = agents or dict(
            (name, AgentProfile(name)) for name in AGENT_NAMES
        )
        self.shared = shared or {"shell_allow": [], "shell_deny": []}
        self.shared.setdefault("shell_allow", [])
        self.shared.setdefault("shell_deny", [])
        # An older profile said `zsh = true` and nothing else, back when ~/.zsh
        # was one symlink to the whole catalog. Read that as "all fragments",
        # so the first sync after upgrading does not tear down a working shell.
        self.legacy_shell = bool(legacy_shell)
        self.source = source
        self.contributor = contributor

    # -- loading ----------------------------------------------------------
    @classmethod
    def from_text(cls, text, source):
        data = tomlfile.load_data(text)
        agents = {}
        for name in AGENT_NAMES:
            agents[name] = AgentProfile(name, data.get(name) or {})
        shared = data.get("shared") or {}
        per_fragment = "shell_allow" in shared or "shell_deny" in shared
        return cls(
            agents,
            {
                "shell_allow": _names(shared.get("shell_allow")),
                "shell_deny": _names(shared.get("shell_deny")),
            },
            source,
            legacy_shell=not per_fragment and bool(shared.get("zsh", False)),
            contributor=(data.get('catalog') or {}).get('contributor', 'default'),
        )

    # -- shell fragments: one switch for the machine -----------------------
    def is_shell_denied(self, name):
        return name in self.shared["shell_deny"]

    def is_shell_allowed(self, name):
        if self.is_shell_denied(name):
            return False
        if name in self.shared["shell_allow"]:
            return True
        return self.legacy_shell

    def is_shell_undecided(self, name):
        if self.legacy_shell:
            return False
        return not (name in self.shared["shell_allow"] or self.is_shell_denied(name))

    def allow_shell(self, name):
        _discard(self.shared["shell_deny"], name)
        _add(self.shared["shell_allow"], name)

    def deny_shell(self, name):
        _discard(self.shared["shell_allow"], name)
        _add(self.shared["shell_deny"], name)

    def unset_shell(self, name):
        _discard(self.shared["shell_allow"], name)

    @property
    def manages_zsh(self):
        """`~/.zsh` and the `~/.zshrc` block exist while any fragment is on."""
        if self.legacy_shell:
            return True
        return bool([n for n in self.shared["shell_allow"] if not self.is_shell_denied(n)])

    # -- one accessor for every kind, for the init screen -------------------
    def leaf_on(self, kind, name, agent=None):
        if kind == "shell":
            return self.is_shell_allowed(name)
        if kind == "harness":
            return bool(self.agent(agent).harness)
        return self.agent(agent).is_allowed(kind, name)

    def set_leaf(self, kind, name, agent, on):
        if kind == "shell":
            if on:
                self.allow_shell(name)
            else:
                self.deny_shell(name)
        elif kind == "harness":
            self.agent(agent).harness = bool(on)
        elif on:
            self.agent(agent).allow(kind, name)
        else:
            self.agent(agent).deny(kind, name)

    @classmethod
    def load(cls):
        """`local.toml`, or an empty profile.

        There is no committed list of suggestions to fall back on. Before the
        first `init` nothing has been decided, so `sync` says so and installs
        nothing; `init` starts you with every box ticked.
        """
        path = paths.local_profile()
        text = atomic.read_text(path)
        if text is None:
            return cls()
        try:
            return cls.from_text(text, "local")
        except tomlfile.TomlError as exc:
            raise ValueError("%s: %s" % (paths.tilde(path), exc))

    @property
    def initialised(self):
        return os.path.isfile(paths.local_profile())

    def agent(self, name):
        if name not in self.agents:
            self.agents[name] = AgentProfile(name)
        return self.agents[name]

    # -- saving -----------------------------------------------------------
    def render(self):
        chunks = [HEADER]
        if self.contributor != 'default':
            chunks.append(tomlfile.render_table(('catalog',), {'contributor': self.contributor}))
        for name in AGENT_NAMES:
            chunks.append(tomlfile.render_table((name,), self.agent(name).to_toml_map()))
        if self.legacy_shell and not self.shared["shell_allow"] \
                and not self.shared["shell_deny"]:
            # Nothing decided per fragment yet. Keep the old flag rather than
            # writing two empty lists, which would read as "none of them" and
            # uninstall a working shell on the next sync.
            shared = {"zsh": True}
        else:
            shared = {
                "shell_allow": sorted(self.shared["shell_allow"]),
                "shell_deny": sorted(self.shared["shell_deny"]),
            }
        chunks.append(tomlfile.render_table(("shared",), shared))
        return "\n".join(chunks) + "\n"

    def save(self, path=None):
        path = path or paths.local_profile()
        atomic.ensure_dir(os.path.dirname(path))
        atomic.atomic_write_text(path, self.render())
        self.source = "local"
        return path


def _names(value):
    if not value:
        return []
    return [str(item) for item in value]


def _add(bucket, name):
    if name not in bucket:
        bucket.append(name)


def _discard(bucket, name):
    while name in bucket:
        bucket.remove(name)
