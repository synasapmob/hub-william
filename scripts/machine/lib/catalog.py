"""What the package has to offer.

The catalog is plain files on disk, so `git pull` is how the catalog changes.
Nothing here reads or writes the home directory.
"""

import os
import re

from . import atomic, paths, tomlfile

SKILL_FILE = "SKILL.md"

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)^---\s*\n", re.DOTALL | re.MULTILINE)
_FIELD_RE = re.compile(r"^(\w[\w-]*)\s*:\s*(.*)$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class CatalogError(Exception):
    pass


def check_name(name):
    """Names become path segments and TOML keys. Keep them boring."""
    if not NAME_RE.match(name or "") or name in (".", ".."):
        raise CatalogError(
            "bad name %r: use letters, digits, dot, dash or underscore" % name
        )
    return name


class Skill(object):
    def __init__(self, name, path, description=""):
        self.name = name
        self.path = path
        self.description = description

    @property
    def kind(self):
        return "skill"


class Mcp(object):
    def __init__(self, name, path, data):
        self.name = name
        self.path = path
        self.url = data.get("url")
        self.command = data.get("command")
        self.args = list(data.get("args") or [])
        self.env = dict(data.get("env") or {})
        self.description = data.get("description", "")
        self.auth = data.get("auth")
        if not self.url and not self.command:
            raise CatalogError("%s: needs either `url` or `command`" % paths.tilde(path))
        if self.url and self.command:
            raise CatalogError("%s: has both `url` and `command`" % paths.tilde(path))

    @property
    def kind(self):
        return "mcp"

    @property
    def transport(self):
        return "http" if self.url else "stdio"

    @property
    def is_oauth(self):
        """HTTP servers log in through the agent; stdio ones never do."""
        if self.auth == "none":
            return False
        return bool(self.url)

    def spec(self):
        """The catalog's own view, used for fingerprinting and comparison."""
        if self.url:
            out = {"url": self.url}
        else:
            out = {"command": self.command, "args": self.args}
        if self.env:
            out["env"] = dict(self.env)
        return out

    def summary(self):
        if self.url:
            return self.url
        return " ".join([self.command] + self.args)


class Shell(object):
    """One `.zsh` fragment. Machine-wide: a shell has no idea which agent
    started it, so these are one switch for the whole machine."""

    def __init__(self, name, path, description=""):
        self.name = name
        self.path = path
        self.description = description

    @property
    def kind(self):
        return "shell"


class Harness(object):
    """The always-on markdown. There is exactly one, and each agent reads it
    under its own filename, so it is chosen per agent like a skill."""

    name = "AGENTS.md"

    def __init__(self, path):
        self.path = path
        self.description = "always on, every session"

    @property
    def kind(self):
        return "harness"


class Plugin(object):
    def __init__(self, name, path, data):
        self.name = name
        self.path = path
        self.marketplace = data.get("marketplace")
        self.source = data.get("source")
        self.plugin = data.get("plugin") or name
        self.agents = list(data.get("agents") or ["claude"])
        self.description = data.get("description", "")

    @property
    def kind(self):
        return "plugin"


def _read_toml(path):
    text = atomic.read_text(path)
    if text is None:
        raise CatalogError("%s is missing" % paths.tilde(path))
    try:
        return tomlfile.load_data(text)
    except tomlfile.TomlError as exc:
        raise CatalogError("%s: %s" % (paths.tilde(path), exc))


def skill_description(skill_path):
    text = atomic.read_text(os.path.join(skill_path, SKILL_FILE), default="")
    match = _FRONTMATTER_RE.search(text or "")
    if match:
        for line in match.group(1).splitlines():
            field = _FIELD_RE.match(line.strip())
            if field and field.group(1).lower() == "description":
                return field.group(2).strip().strip("'\"")
    for line in (text or "").splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def skills():
    root = paths.skills_catalog()
    out = []
    if not os.path.isdir(root):
        return out
    for name in sorted(os.listdir(root)):
        if name.startswith("."):
            continue
        path = os.path.join(root, name)
        if not os.path.isdir(path):
            continue
        if not os.path.isfile(os.path.join(path, SKILL_FILE)):
            continue
        out.append(Skill(name, path, skill_description(path)))
    return out


def mcps():
    root = paths.mcp_catalog()
    out = []
    if not os.path.isdir(root):
        return out
    for filename in sorted(os.listdir(root)):
        if not filename.endswith(".toml") or filename.startswith("."):
            continue
        name = filename[:-5]
        path = os.path.join(root, filename)
        out.append(Mcp(name, path, _read_toml(path)))
    return out


def plugins():
    root = paths.plugins_catalog()
    out = []
    if not os.path.isdir(root):
        return out
    for filename in sorted(os.listdir(root)):
        if not filename.endswith(".toml") or filename.startswith("."):
            continue
        name = filename[:-5]
        path = os.path.join(root, filename)
        out.append(Plugin(name, path, _read_toml(path)))
    return out


def by_name(items):
    return dict((item.name, item) for item in items)


def find_skill(name):
    return by_name(skills()).get(name)


def find_mcp(name):
    return by_name(mcps()).get(name)


def has_harness():
    return os.path.isfile(paths.harness_file())


def harness():
    path = paths.harness_file()
    return Harness(path) if os.path.isfile(path) else None


def has_zsh():
    return os.path.isdir(paths.zsh_catalog())


_SECRETS = ("secrets.zsh", "secrets.zsh.example")


def _first_comment(path):
    """A fragment's own one-line summary: the first `#` line in the file."""
    text = atomic.read_text(path, default="") or ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
        break
    return ""


def shell_fragments():
    """The `.zsh` files, minus secrets — those are values, not a fragment you
    can decline."""
    root = paths.zsh_catalog()
    out = []
    if not os.path.isdir(root):
        return out
    for filename in sorted(os.listdir(root)):
        if not filename.endswith(".zsh") or filename.startswith("."):
            continue
        if filename in _SECRETS:
            continue
        path = os.path.join(root, filename)
        out.append(Shell(filename, path, _first_comment(path)))
    return out


# --- groups: what the init screen shows at the top level -------------------

class Member(object):
    """One row inside a group: a catalog item, or a name not written yet."""

    def __init__(self, kind, name, item=None):
        self.kind = kind          # a profile kind: skills, mcp, shell, harness
        self.name = name
        self.item = item

    @property
    def present(self):
        return self.item is not None

    @property
    def per_agent(self):
        """A shell fragment is loaded by the shell, which has no idea which
        agent it is for. Everything else is chosen agent by agent."""
        return self.kind != "shell"

    @property
    def description(self):
        if self.item is None:
            return "not in the catalog yet"
        if self.kind == "mcp":
            return self.item.summary()
        return getattr(self.item, "description", "")


class Group(object):
    def __init__(self, name, description="", members=None):
        self.name = name
        self.description = description
        self.members = members or []


_GROUP_LISTS = (("shell", "shell"), ("mcp", "mcp"), ("skills", "skills"))


def groups():
    """`catalog/groups.toml`, in file order.

    Anything in the catalog that no group names is appended as `other`, so an
    item can never be installed by `sync` while being invisible in `init`.
    """
    index = {
        "skills": by_name(skills()),
        "mcp": by_name(mcps()),
        "shell": by_name(shell_fragments()),
    }
    harness_item = harness()
    path = paths.groups_file()
    text = atomic.read_text(path)
    if text is None:
        data = {}
    else:
        try:
            data = tomlfile.load_data(text)
        except tomlfile.TomlError as exc:
            raise CatalogError("%s: %s" % (paths.tilde(path), exc))

    out = []
    claimed = set()
    for name, body in data.items():
        if not isinstance(body, dict):
            raise CatalogError(
                "%s: [%s] must be a table" % (paths.tilde(path), name)
            )
        members = []
        for key, kind in _GROUP_LISTS:
            for item_name in body.get(key) or []:
                item_name = str(item_name)
                members.append(Member(kind, item_name, index[kind].get(item_name)))
                claimed.add((kind, item_name))
        if body.get("harness") and harness_item is not None:
            members.append(Member("harness", harness_item.name, harness_item))
            claimed.add(("harness", harness_item.name))
        out.append(Group(name, str(body.get("description") or ""), members))

    leftovers = []
    for kind in ("shell", "mcp", "skills"):
        for item_name in sorted(index[kind]):
            if (kind, item_name) not in claimed:
                leftovers.append(Member(kind, item_name, index[kind][item_name]))
    if harness_item is not None and ("harness", harness_item.name) not in claimed:
        leftovers.append(Member("harness", harness_item.name, harness_item))
    if leftovers:
        out.append(Group("other", "in the catalog, in no group", leftovers))
    return out


def mcp_path(name):
    return os.path.join(paths.mcp_catalog(), check_name(name) + ".toml")


def write_mcp(name, spec, description=""):
    """Create/replace `catalog/mcp/<name>.toml`. Never holds a token."""
    check_name(name)
    lines = []
    if description:
        lines.append("description = " + tomlfile.dump_string(description))
    if "url" in spec:
        lines.append("url = " + tomlfile.dump_string(spec["url"]))
    else:
        lines.append("command = " + tomlfile.dump_string(spec["command"]))
        lines.append("args = " + tomlfile.dump_value(list(spec.get("args") or [])))
    if spec.get("env"):
        lines.append("")
        lines.append(tomlfile.render_table(("env",), spec["env"]))
    path = mcp_path(name)
    atomic.ensure_dir(os.path.dirname(path))
    atomic.atomic_write_text(path, "\n".join(lines) + "\n")
    return path


def delete_mcp(name):
    path = mcp_path(name)
    if os.path.isfile(path):
        os.unlink(path)
        return path
    return None


def delete_skill(name):
    import shutil
    path = os.path.join(paths.skills_catalog(), check_name(name))
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
        return path
    return None
