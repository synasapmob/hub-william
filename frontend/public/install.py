#!/usr/bin/env python3
"""Bootstrap Hub William from a public checkout.

The script is intentionally dependency-free so this works on a machine whose
only preparation is Python 3.8 and git:

    curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 -
"""

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


REPOSITORY_URL = os.environ.get(
    "HUB_WILLIAM_REPOSITORY",
    "https://github.com/synasapmob/hub-william.git",
)
CHECKOUT = Path(
    os.environ.get("HUB_WILLIAM_HOME", str(Path.home() / ".hub-william"))
).expanduser()
PROJECT_RULES = Path(".agents/rules/hub-william")
PROJECT_MARKER = ".hub-william-project"
BLOCK_BEGIN = "<!-- hub-william-project: begin -->"
BLOCK_END = "<!-- hub-william-project: end -->"


def say(message):
    print("hub-william: %s" % message)


def fail(message):
    raise SystemExit("hub-william: %s" % message)


def run(command, cwd=None, stdin=None):
    completed = subprocess.run(
        [str(part) for part in command],
        cwd=str(cwd) if cwd else None,
        stdin=stdin,
    )
    if completed.returncode != 0:
        fail("command failed (%d): %s" % (
            completed.returncode,
            " ".join(str(part) for part in command),
        ))


def require(command):
    if shutil.which(command) is None:
        fail("%s is not on PATH" % command)


def ensure_checkout():
    require("git")

    if (CHECKOUT / ".git").is_dir():
        say("updating %s" % CHECKOUT)
        run(["git", "-C", CHECKOUT, "pull", "--ff-only"])
    elif CHECKOUT.exists():
        fail("%s exists and is not a git checkout" % CHECKOUT)
    else:
        say("installing into %s" % CHECKOUT)
        run([
            "git",
            "clone",
            "--filter=blob:none",
            "--sparse",
            REPOSITORY_URL,
            CHECKOUT,
        ])

    run([
        "git",
        "-C",
        CHECKOUT,
        "sparse-checkout",
        "set",
        "--no-cone",
        "/frontend/scripts/",
        "/contributors/",
    ])

    installer = CHECKOUT / "frontend/scripts/machine/install.sh"
    if not installer.is_file():
        fail("checkout does not contain frontend/scripts/machine/install.sh")

    return installer


def managed_block():
    dispatcher = PROJECT_RULES / "contributors/default/libraries/harness/AGENTS.md"

    return "\n".join([
        BLOCK_BEGIN,
        "## Hub William project rules",
        "",
        "Before planning or acting, read and follow `%s`." % dispatcher,
        "Resolve every path it names from `.agents/rules/hub-william/`.",
        BLOCK_END,
    ])


def with_managed_block(source):
    block = managed_block()
    has_begin = BLOCK_BEGIN in source
    has_end = BLOCK_END in source

    if has_begin != has_end:
        fail("project instruction file has an incomplete Hub William block")

    if has_begin:
        pattern = re.compile(
            re.escape(BLOCK_BEGIN) + r".*?" + re.escape(BLOCK_END),
            re.DOTALL,
        )
        return pattern.sub(block, source, count=1)

    if not source:
        return block + "\n"

    return source.rstrip() + "\n\n" + block + "\n"


def write_atomic(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(".%s.hub-william-%d" % (path.name, os.getpid()))
    temporary.write_text(contents, encoding="utf-8")
    if path.exists():
        os.chmod(temporary, path.stat().st_mode & 0o777)
    os.replace(str(temporary), str(path))


def rewrite_project_paths(root):
    for path in root.rglob("*"):
        if not path.is_file() or path.name == PROJECT_MARKER:
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        updated = source.replace(
            "~/.hub-william/",
            ".agents/rules/hub-william/",
        )
        if updated != source:
            path.write_text(updated, encoding="utf-8")


def install_project(project_argument):
    project = Path(project_argument).expanduser().resolve()

    if not project.is_dir():
        fail("project path is not a directory: %s" % project)
    if project == Path.home().resolve() or project == Path(project.anchor):
        fail("--path must name a project directory, not %s" % project)

    source = CHECKOUT / "contributors"
    target = project / PROJECT_RULES
    marker = target / PROJECT_MARKER
    temporary = target.with_name(".%s-%d" % (target.name, os.getpid()))
    previous = target.with_name(".%s-previous-%d" % (target.name, os.getpid()))

    if target.exists() and not marker.is_file():
        fail("%s exists and is not managed by Hub William" % target)
    if temporary.exists() or previous.exists():
        fail("temporary project install path already exists")

    instruction_paths = [project / "AGENTS.md", project / "CLAUDE.md"]
    desired = []

    for path in instruction_paths:
        if path.is_symlink():
            fail("refusing to replace symlinked instruction file: %s" % path)
        source_text = path.read_text(encoding="utf-8") if path.exists() else ""
        desired.append((path, with_managed_block(source_text)))

    temporary.mkdir(parents=True)
    shutil.copytree(str(source), str(temporary / "contributors"))
    (temporary / PROJECT_MARKER).write_text(
        "Generated by Hub William. Re-run install.py --path to update.\n",
        encoding="utf-8",
    )
    rewrite_project_paths(temporary)

    moved = False
    try:
        if target.exists():
            os.replace(str(target), str(previous))
            moved = True
        os.replace(str(temporary), str(target))
        if moved:
            shutil.rmtree(str(previous))
    except Exception:
        if moved and not target.exists() and previous.exists():
            os.replace(str(previous), str(target))
        raise
    finally:
        if temporary.exists():
            shutil.rmtree(str(temporary))

    for path, contents in desired:
        write_atomic(path, contents)

    say("project rules installed at %s" % target)


def registry_servers():
    registry = CHECKOUT / "frontend/scripts/machine/registries/mcp"
    return sorted(path.stem for path in registry.glob("*.toml"))


def selected_mcp_servers(value):
    available = registry_servers()
    aliases = {
        "chrome-browser": ["chrome-devtools"],
        "supabase": [name for name in available if name.startswith("supabase-")],
    }
    requested = [item.strip() for item in value.split(",") if item.strip()]

    if requested == ["all"]:
        return available
    if not requested:
        fail("--mcp needs `all` or a comma-separated list")

    selected = []
    for name in requested:
        expanded = aliases.get(name, [name])
        if not expanded or any(server not in available for server in expanded):
            products = sorted(set(available) | set(aliases))
            fail("unknown MCP %r; available: %s" % (name, ", ".join(products)))
        for server in expanded:
            if server not in selected:
                selected.append(server)

    return selected


def install_mcps(installer, value):
    servers = selected_mcp_servers(value)
    for server in servers:
        run([installer, "mcp", "add", server, "--yes"])
    say("installed MCP: %s" % ", ".join(servers))


def terminal_input():
    try:
        return open("/dev/tty", "rb", buffering=0)
    except OSError:
        return None


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Install Hub William globally or into one project.",
    )
    parser.add_argument(
        "--path",
        metavar="PROJECT",
        help="install managed Documents into one project's .agents/rules",
    )
    parser.add_argument(
        "--mcp",
        metavar="NAMES",
        help="install all MCPs or a comma-separated product list",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="accept the global installer's preselected defaults",
    )
    args = parser.parse_args(argv)

    if args.path and args.mcp:
        parser.error("--path and --mcp are separate install scopes")

    return args


def main(argv=None):
    if sys.version_info < (3, 8):
        fail("Python 3.8 or newer is required")

    args = parse_args(sys.argv[1:] if argv is None else argv)
    installer = ensure_checkout()

    if args.path:
        install_project(args.path)
        return 0
    if args.mcp:
        install_mcps(installer, args.mcp)
        return 0

    command = [installer, "init"]
    if args.yes:
        command.append("--yes")

    tty = terminal_input()
    if tty is None and not args.yes:
        fail("no terminal available; download install.py or add --yes")
    try:
        run(command, stdin=tty)
    finally:
        if tty is not None:
            tty.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
