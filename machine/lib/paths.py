"""Where things live.

Home is read at call time, never cached, so the tests can point HOME at a temp
directory and get a fully isolated machine.
"""

import os

MARKER = "hub william machine"
MARKER_COMMENT_PREFIX = "# " + MARKER + ":"


def machine_dir():
    """The `machine/` package directory."""
    override = os.environ.get("HUB_WILLIAM_MACHINE_DIR")
    if override:
        return os.path.abspath(override)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def repo_root():
    return os.path.dirname(machine_dir())


def home():
    return os.environ.get("HOME") or os.path.expanduser("~")


# --- catalog: the package's source of truth -------------------------------

def catalog_dir():
    return os.path.join(machine_dir(), "catalog")


def skills_catalog():
    return os.path.join(catalog_dir(), "skills")


def mcp_catalog():
    return os.path.join(catalog_dir(), "mcp")


def plugins_catalog():
    return os.path.join(catalog_dir(), "plugins")


def harness_file():
    return os.path.join(catalog_dir(), "harness", "AGENTS.md")


def zsh_catalog():
    return os.path.join(catalog_dir(), "zsh")


def groups_file():
    return os.path.join(catalog_dir(), "groups.toml")


def secrets_example():
    return os.path.join(zsh_catalog(), "secrets.zsh.example")


def secrets_file():
    """Real values live in home, never inside the repo.

    They used to sit next to the example in `catalog/zsh/` back when `~/.zsh`
    was one symlink to that directory. `sync` moves the old file here.
    """
    return os.path.join(home_zsh(), "secrets.zsh")


def legacy_secrets_file():
    return os.path.join(zsh_catalog(), "secrets.zsh")


def zshrc_fragment():
    return os.path.join(catalog_dir(), "shell", "zshrc")


# --- profiles and state ---------------------------------------------------

def profiles_dir():
    return os.path.join(machine_dir(), "profiles")


def local_profile():
    return os.path.join(profiles_dir(), "local.toml")


def state_dir():
    return os.path.join(machine_dir(), "state")


def applied_file():
    return os.path.join(state_dir(), "applied.json")


def lock_file():
    return os.path.join(state_dir(), ".lock")


# --- home-side targets ----------------------------------------------------

def home_zsh():
    return os.path.join(home(), ".zsh")


def home_zshrc():
    return os.path.join(home(), ".zshrc")


def tilde(path):
    """`/Users/me/x` -> `~/x`, for display only."""
    h = home().rstrip("/")
    path = os.path.abspath(path)
    if path == h:
        return "~"
    if h and path.startswith(h + "/"):
        return "~" + path[len(h):]
    return path
