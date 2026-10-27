#!/usr/bin/env python3
# memory: see and manage what your coding agents remember, and the rules and skills you give them
#
# A terminal browser for agent memory: the instruction files you write for them (CLAUDE.md,
# AGENTS.md, GEMINI.md) and the lessons they save about you, for Claude Code, Codex, Grok and agy.
# It lists each one with its size, how many files it holds and when it last changed, lets you
# open a folder to look inside and read a file, and moves learned memory to the Trash. Your
# instruction files are read-only here, and nothing is ever deleted for good. Nothing leaves
# your computer.
#
# Run it from Hub William (it reads and writes only under your home folder, and needs a
# terminal on macOS or Linux with Python 3.9 or newer):
#   curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/memory/memory.py | python3
# Or run a downloaded copy: python3 memory.py
# Print the table without the interface, changing nothing: python3 memory.py --list
#
# Keys: arrows or h j k l move, Right or Enter opens a folder or reads a file, Left goes back,
# d deletes the learned memory under the cursor after a preview and a y/N question, r scans
# again, q quits. Each folder remembers where the cursor was while the tool runs; a new run
# starts from the top.

import argparse
import errno
import json
import locale
import os
import re
import shutil
import sqlite3
import stat
import sys
import time
from collections import namedtuple
from urllib.parse import quote

try:
    import curses
except ImportError:  # Windows ships no curses
    curses = None

RULES = "rules"  # instruction files that you write: read-only here
LEARNED = "memory"  # what an agent saved by itself
SKILLS = "skills"  # skill folders (a folder with a SKILL.md): read-only here
MIXED = "mixed"

MIN_WIDTH = 64
MIN_HEIGHT = 12
MAX_VIEW = 256 * 1024
MAX_MEMORIES = 500

# Where each agent keeps things, as paths under the home folder. The memory tab reads "memory"
# (folders of files the agent writes, which may be moved to the Trash), "indexes" (files an
# agent generates from its memory: shown, never changed), "databases" (SQLite files the agent
# writes: shown, never changed) and "projects" (the folder that holds one subfolder per project
# or workspace, the names of the memory folders inside each, and how a subfolder's name becomes
# a label). The rules tab reads "instructions" (files you write), "rules_dirs" (folders of such
# files), "skills" (folders of skills) and the instruction files that may sit in a project
# itself. The paths come from the agents' documentation and from what exists on one machine, so
# add to them with care.
ProjectSpec = namedtuple("ProjectSpec", "folder memory instructions index label", defaults=((), "path"))
AgentSpec = namedtuple(
    "AgentSpec", "name folder instructions memory databases projects rules_dirs indexes skills",
    defaults=((), (), (), None, (), (), ()),
)
SHARED = "~/.agents"  # the folder the agents' rules and skills are linked from
AGENTS = (
    AgentSpec("claude", ".claude", projects=ProjectSpec(".claude/projects", ("memory",), ())),
    AgentSpec("codex", ".codex", memory=(".codex/memories",), databases=(".codex/memories_1.sqlite",)),
    AgentSpec(
        "grok", ".grok",
        memory=(".grok/memory-v2/global/topics", ".grok/memory-v2/global/observations"),
        projects=ProjectSpec(".grok/memory-v2/workspaces", ("topics", "observations"), (), ("MEMORY.md",), "hash"),
        indexes=(".grok/memory-v2/global/MEMORY.md",),
    ),
    AgentSpec("agy", ".gemini"),
)
RULES_AGENTS = (
    AgentSpec(
        "claude", ".claude", instructions=(".claude/CLAUDE.md",),
        projects=ProjectSpec(
            ".claude/projects", (),
            ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", "GEMINI.md"),
        ),
        skills=((".claude/skills", "skills"),),
    ),
    AgentSpec("codex", ".codex", instructions=(".codex/AGENTS.md",), skills=((".codex/skills/.system", "skills"),)),
    AgentSpec("grok", ".grok", rules_dirs=(".grok/rules",), skills=((".grok/skills", "skills"),)),
    AgentSpec(
        "agy", ".gemini", instructions=(".gemini/AGENTS.md", ".gemini/GEMINI.md"),
        skills=((".gemini/config/skills", "skills"),),
    ),
    AgentSpec(SHARED, ".agents", instructions=(".agents/AGENTS.md",), skills=((".agents/skills", "skills"),)),
)

UNICODE_CHARS = {
    "h": "─", "v": "│", "tl": "┌", "tr": "┐", "bl": "└",
    "br": "┘", "ml": "├", "mr": "┤", "crumb": " › ", "dot": " · ",
    "ellipsis": "…", "updown": "↑↓", "right": "→", "left": "←",
}
ASCII_CHARS = {
    "h": "-", "v": "|", "tl": "+", "tr": "+", "bl": "+", "br": "+", "ml": "+", "mr": "+",
    "crumb": " > ", "dot": " | ", "ellipsis": "...", "updown": "Up/Down", "right": "->",
    "left": "<-",
}


# --- Finding memory ---------------------------------------------------------------------


class Entry(object):
    """A file, a folder, or a group of them (path is None) with what is inside it added up."""

    __slots__ = (
        "name", "path", "is_dir", "kind", "agent", "root", "size", "paths", "mtime", "children",
        "always", "missing", "deletable", "link", "text", "note", "broken", "alerts",
    )

    def __init__(self, name, path=None, is_dir=True, kind=RULES, agent=None, root=None):
        self.name = name
        self.path = path
        self.is_dir = is_dir
        self.kind = kind
        self.agent = agent
        self.root = root
        self.size = 0
        self.paths = 0
        self.mtime = 0.0
        self.children = []
        self.always = False  # an agent is listed even when it has no size
        self.missing = False  # the agent's folder does not exist
        self.deletable = False  # a file, folder or link that may go to the Trash
        self.link = None  # where a symlink points, for an instruction file that is one
        self.text = None  # the content of an entry that is not a file, such as a database row
        self.note = None  # why a folder cannot be opened
        self.broken = False  # a symlink whose target is not there: listed in red, never read
        self.alerts = 0  # how many broken links are in it, itself included

    def add(self, child):
        self.children.append(child)
        self.size += child.size
        self.paths += child.paths
        self.alerts += child.alerts
        self.mtime = max(self.mtime, child.mtime)

    def sort(self):
        self.children.sort(key=lambda child: (-child.size, child.name))

    def visible(self):
        """What the screens list: an entry with no size is not shown, except an agent or a broken link."""
        return [child for child in self.children if child.size > 0 or child.always or child.alerts]


def listed(path):
    """A path with its folder resolved and its own name kept, so a link stays a link."""
    return os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))


def tilde(path, home):
    for prefix in (home, os.path.realpath(home)):
        if path == prefix:
            return "~"
        if path.startswith(prefix + os.sep):
            return "~" + path[len(prefix):]
    return path


def find_project(folder):
    """The path Claude's project folder name stands for, or None.

    Claude writes "/" and "." both as "-", so "hub-william" could be "hub/william" and "my-app" could
    be "my.app". The only way to tell is to look for the path that exists: each folder name that
    exists is compared with its dots written as dashes.
    """
    if not folder.startswith("-"):
        return None
    tokens = folder[1:].split("-")
    listings = {}

    def names(current):
        if current not in listings:
            table = {}
            try:
                for name in os.listdir(current):
                    table.setdefault(name.replace(".", "-"), []).append(name)
            except OSError:
                pass
            listings[current] = table
        return listings[current]

    def walk(current, index):
        if index == len(tokens):
            return current
        table = names(current)
        for end in range(index + 1, len(tokens) + 1):
            for name in sorted(table.get("-".join(tokens[index:end]), ())):
                candidate = os.path.join(current, name)
                if end == len(tokens):
                    if os.path.lexists(candidate):
                        return candidate
                elif os.path.isdir(candidate):
                    found = walk(candidate, end)
                    if found:
                        return found
        return None

    return walk(os.sep, 0)


def project_label(folder, home, style="path"):
    if style == "hash":  # Grok names a workspace folder "<name>-<8 hex digits>"
        return re.sub(r"-[0-9a-f]{8}$", "", folder) or folder
    found = find_project(folder)
    return tilde(found, home) if found else folder


def broken_entry(path, kind, agent, info):
    """A symlink to nothing. It is listed so that it does not vanish; the tool only warns about it."""
    entry = Entry(os.path.basename(path), path, False, kind, agent)
    entry.broken = True
    entry.alerts = 1
    entry.deletable = kind != LEARNED
    entry.mtime = info.st_mtime
    try:
        entry.link = os.path.realpath(path)
    except (OSError, RuntimeError):
        entry.link = path
    return entry


def points_nowhere(path):
    """Whether a symlink's target is missing, or the links go round in a circle."""
    try:
        os.stat(path)
    except OSError as error:
        return error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)
    return False


def file_entry(path, kind, agent):
    """An instruction file; a symlink to a regular file counts, with its target's size."""
    try:
        info = os.lstat(path)
        target = None
        if stat.S_ISLNK(info.st_mode):
            if kind != LEARNED and points_nowhere(path):
                return broken_entry(path, kind, agent, info)
            info = os.stat(path)
            target = os.path.realpath(path)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    entry = Entry(os.path.basename(path), path, False, kind, agent)
    entry.deletable = kind != LEARNED  # a generated index is not ours to move
    entry.size = info.st_size
    entry.mtime = info.st_mtime
    entry.link = target
    entry.paths = 1 if entry.size > 0 else 0
    return entry


def scan_memory(path, agent, root):
    """Learned memory: a folder or file the agent wrote. Sizes are the text sizes; symlinks are skipped."""
    if os.path.basename(path) == ".git":
        return None  # Codex keeps its memory folder under git; the repository is not memory
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if stat.S_ISLNK(info.st_mode):
        return None
    entry = Entry(os.path.basename(path), path, stat.S_ISDIR(info.st_mode), LEARNED, agent, root)
    entry.deletable = True
    entry.mtime = info.st_mtime
    if entry.is_dir:
        try:
            names = os.listdir(path)
        except OSError:
            names = []
        for name in names:
            child = scan_memory(os.path.join(path, name), agent, root)
            if child is not None:
                entry.add(child)
        entry.sort()
    elif stat.S_ISREG(info.st_mode):
        entry.size = info.st_size
        entry.paths = 1 if entry.size > 0 else 0
    else:
        return None
    return entry


def read_memories(path):
    """The memories in a Codex database as (name, text, time) tuples; raises sqlite3.Error if it cannot be read.

    A database in WAL mode cannot be opened read-only once its side files are gone, so then it is
    opened as immutable, which also reads it and cannot change it.
    """
    query = (
        "SELECT thread_id, rollout_slug, rollout_summary, raw_memory, generated_at"
        " FROM stage1_outputs ORDER BY generated_at DESC LIMIT %d" % MAX_MEMORIES
    )
    rows = None
    for mode in ("mode=ro", "immutable=1"):
        try:
            connection = sqlite3.connect("file:%s?%s" % (quote(path), mode), uri=True)
            try:
                rows = connection.execute(query).fetchall()
            finally:
                connection.close()
            break
        except sqlite3.OperationalError as error:
            if "unable to open" not in str(error) or mode == "immutable=1":
                raise
    found = []
    for thread, slug, summary, raw, generated in rows:
        name = slug or str(thread)[:12]
        text = "# %s\n\n%s\n\n---\n\n%s\n" % (name, summary or "", raw or "")
        moment = float(generated or 0)
        found.append((name, text, moment / 1000.0 if moment > 1e11 else moment))
    return found


def database_entry(path, agent):
    """A Codex memory database: its size is the file's, and each memory is a read-only row."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    entry = Entry(os.path.basename(path), path, True, LEARNED, agent)
    entry.size = info.st_size
    entry.mtime = info.st_mtime
    try:
        memories = read_memories(path)
    except sqlite3.Error as error:
        known = "no such" in str(error) or "not a database" in str(error)
        entry.note = (
            "%s has a layout this tool does not know, so its memories are not shown." % entry.name
            if known
            else "%s could not be opened read-only (%s)." % (entry.name, error)
        )
        return entry
    seen = {}
    for name, text, moment in memories:
        seen[name] = seen.get(name, 0) + 1
        row = Entry(name if seen[name] == 1 else "%s (%d)" % (name, seen[name]), None, False, LEARNED, agent)
        row.text = text
        row.size = len(text.encode("utf-8"))
        row.paths = 1
        row.mtime = moment
        entry.children.append(row)
    entry.paths = len(entry.children)
    if not entry.children:
        entry.size = 0  # nothing is stored in it, so there is nothing to list
        entry.note = "No memories are stored in %s yet." % entry.name
    return entry


def skill_tree(path, name, agent):
    """A skill folder with its files, following a link at the top only."""
    real = os.path.realpath(path)
    entry = Entry(name, path, True, SKILLS, agent)
    entry.deletable = True
    entry.link = real if os.path.islink(path) else None
    try:
        entry.mtime = os.stat(real).st_mtime
        names = sorted(os.listdir(real))
    except OSError:
        return entry
    for child in names:
        if child.startswith("."):
            continue
        full = os.path.join(real, child)
        if os.path.islink(full) and os.path.isdir(full):
            continue  # a link to a folder inside a skill could loop
        if os.path.isdir(full):
            entry.add(skill_tree(full, child, agent))
        else:
            item = file_entry(full, SKILLS, agent)
            if item is not None:
                entry.add(item)
    entry.sort()
    return entry


def skill_entries(path, agent):
    """The skills under a folder: a skill is a folder holding SKILL.md, and any other folder is a group of them."""
    found = []
    try:
        names = sorted(os.listdir(path))
    except OSError:
        return found
    for name in names:
        child = os.path.join(path, name)
        if name.startswith("."):
            continue
        if os.path.islink(child) and points_nowhere(child):
            found.append(broken_entry(child, SKILLS, agent, os.lstat(child)))
            continue
        if not os.path.isdir(child):
            continue
        if os.path.isfile(os.path.join(child, "SKILL.md")):
            found.append(skill_tree(child, name, agent))
            continue
        inner = skill_entries(child, agent)
        while len(inner) == 1 and inner[0].path is None:  # a lone wrapper folder adds nothing
            inner = inner[0].children
        if inner:
            group = Entry(name, None, True, SKILLS, agent)
            for item in inner:
                group.add(item)
            group.sort()
            found.append(group)
    return found


def load_agent(spec, home, places):
    """One agent as a group, listed even when it has no memory.

    An agent that has projects shows Global and then each project; any other shows its files
    directly.
    """
    agent = Entry(spec.name, None, True, RULES, spec.name)
    agent.always = True
    agent.missing = not os.path.isdir(os.path.join(home, spec.folder))

    def global_entries():
        saved = []  # the notes the agent wrote, to decide whether its index is worth showing
        for relative in spec.instructions:
            entry = file_entry(listed(os.path.join(home, relative)), RULES, spec.name)
            if entry is not None:
                yield entry
        for relative in spec.rules_dirs:
            folder = os.path.realpath(os.path.join(home, relative))
            try:
                names = sorted(os.listdir(folder))
            except OSError:
                names = []
            for name in names:
                if name.endswith(".md"):
                    entry = file_entry(os.path.join(folder, name), RULES, spec.name)
                    if entry is not None:
                        yield entry
        for relative, label in spec.skills:
            skills = skill_entries(os.path.realpath(os.path.join(home, relative)), spec.name)
            if skills:
                group = Entry(label, None, True, SKILLS, spec.name)
                for item in skills:
                    group.add(item)
                group.sort()
                yield group
        for relative in spec.memory:
            parent = os.path.realpath(os.path.dirname(os.path.join(home, relative)))
            name = os.path.basename(relative)
            places.setdefault(parent, set()).add(name)
            entry = scan_memory(os.path.join(parent, name), spec.name, parent)
            if entry is not None:
                saved.append(entry)
                yield entry
        for relative in spec.databases:
            entry = database_entry(os.path.join(home, relative), spec.name)
            if entry is not None:
                yield entry
        if any(entry.size > 0 for entry in saved):  # an index with no notes under it says nothing
            for relative in spec.indexes:
                entry = file_entry(os.path.join(home, relative), LEARNED, spec.name)
                if entry is not None:
                    yield entry

    if spec.projects is None:
        for entry in global_entries():
            agent.add(entry)
        agent.sort()
        return agent

    shared = Entry("Global", None, True, RULES, spec.name)
    for entry in global_entries():
        shared.add(entry)
    shared.sort()
    projects = []
    folder = os.path.realpath(os.path.join(home, spec.projects.folder))
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        names = []
    for name in names:
        root = os.path.realpath(os.path.join(folder, name))
        if not os.path.isdir(root):
            continue
        project = Entry(project_label(name, home, spec.projects.label), None, True, RULES, spec.name)
        for memory_name in spec.projects.memory:
            places.setdefault(root, set()).add(memory_name)
            memory = scan_memory(os.path.join(root, memory_name), spec.name, root)
            if memory is not None:
                project.add(memory)
        if any(child.size > 0 for child in project.children):
            for index_name in spec.projects.index:
                entry = file_entry(os.path.join(root, index_name), LEARNED, spec.name)
                if entry is not None:
                    project.add(entry)
        found = find_project(name) if spec.projects.label == "path" else None
        for relative in spec.projects.instructions if found else ():
            entry = file_entry(listed(os.path.join(found, relative)), RULES, spec.name)
            if entry is not None:
                project.add(entry)
        project.sort()
        projects.append(project)
    agent.add(shared)
    projects.sort(key=lambda project: (-project.size, project.name))
    for project in projects:
        agent.add(project)
    return agent


class Library(object):
    """Every agent's memory under one home folder, as scanned at one moment."""

    def __init__(self, home, root, places, scanned_at, what="memory files", noun="learned memory", kinds=(LEARNED,)):
        self.home = home
        self.root = root
        self.places = places
        self.scanned_at = scanned_at
        self.what = what  # what an agent with nothing "has no ... yet"
        self.noun = noun  # what a delete preview is about
        self.kinds = kinds  # the only kinds of entry that may be moved to the Trash


def load(home, now=None, progress=None, specs=AGENTS, title="memory", what="memory files",
         noun="learned memory", kinds=(LEARNED,)):
    places = {}
    root = Entry(title)
    for spec in specs:
        if progress is not None:
            progress(spec.name)
        root.add(load_agent(spec, home, places))
    root.sort()
    return Library(home, root, places, time.time() if now is None else now, what, noun, kinds)


def allow_removal(entry, places):
    """Record where each rule, skill and link sits, so that the guard can check it again before a move."""
    if entry.deletable and entry.path is not None:
        entry.root = os.path.dirname(entry.path)
        places.setdefault(entry.root, set()).add(os.path.basename(entry.path))
    for child in entry.children:
        allow_removal(child, places)


def load_rules(home, now=None, progress=None):
    """The rules tab: instruction files and skills, which may go to the Trash like memory."""
    library = load(home, now, progress, RULES_AGENTS, "rules", "rules or skills", "rules and skills", (RULES, SKILLS))
    # ~/.agents is where the other agents' files really live, so it comes first; the rest go by size
    library.root.children.sort(key=lambda agent: (agent.name != SHARED, -agent.size, agent.name))
    allow_removal(library.root, library.places)
    return library


# --- Formatting ------------------------------------------------------------------------


def format_size(size):
    if size < 1024:
        return "%d B" % size
    value = size / 1024.0
    for unit in ("KB", "MB", "GB", "TB"):
        if value < 1000 or unit == "TB":
            return "%d KB" % round(value) if unit == "KB" else "%.1f %s" % (value, unit)
        value /= 1024.0


def format_age(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "now"
    if seconds < 3600:
        return "%dm" % (seconds // 60)
    if seconds < 86400:
        return "%dh" % (seconds // 3600)
    if seconds < 365 * 86400:
        return "%dd" % (seconds // 86400)
    return "%dy" % (seconds // (365 * 86400))


def fit(text, width, chars, tail=False):
    """Exactly width characters; a longer text keeps its end (a path's name) when tail is set."""
    if len(text) <= width:
        return text.ljust(width)
    ellipsis = chars["ellipsis"]
    if width <= len(ellipsis):
        return text[:width]
    if tail:
        return ellipsis + text[len(text) - (width - len(ellipsis)):]
    return text[: width - len(ellipsis)] + ellipsis


# --- Deleting learned memory -----------------------------------------------------------


def prunable(entry):
    """The parts of an entry that may be deleted: memory, rules, skills and links, never an index or a database."""
    if entry.deletable:
        return [entry]
    return [item for child in entry.children for item in prunable(child)]


def kinds_of(entry):
    live = [child for child in entry.children if child.size > 0]
    if not live:
        return set([entry.kind])
    found = set()
    for child in live:
        found |= kinds_of(child)
    return found


def entry_status(entry):
    if entry.broken or (entry.size <= 0 and entry.alerts):
        return "broken"  # a link to nothing, or only links to nothing are left in it
    if entry.size <= 0 and entry.always:
        return "empty"  # no folder, or nothing in it; the message says which
    found = kinds_of(entry)
    return MIXED if len(found) > 1 else next(iter(found))


class Plan(object):
    """What a delete will move. A link moves alone: its target stays, and is counted in kept."""

    def __init__(self, title, items, kept, breaks=(), kept_label="kept (read-only)", show_kept=True):
        self.title = title
        self.items = items
        self.kept = kept
        self.breaks = breaks  # the listed links that would point at nothing afterwards
        self.kept_label = kept_label
        self.show_kept = show_kept
        self.size = sum(item.size for item in items if item.link is None)
        self.paths = sum(item.paths for item in items if item.link is None)


def walk(entry):
    yield entry
    for child in entry.children:
        for item in walk(child):
            yield item


def dangling_links(items, library):
    """The links listed in the library that would point at nothing once the items have moved, as entries."""
    moving = [item.path for item in items]
    gone = [item.path for item in items if item.link is None]
    found = []
    for node in walk(library.root):
        if node.link is None or node.path is None or node.size <= 0:
            continue
        if any(node.path == path or node.path.startswith(path + os.sep) for path in moving):
            continue  # it goes too
        if any(node.link == path or node.link.startswith(path + os.sep) for path in gone):
            found.append(node)
    return found


def refusal(entry, library):
    """Why an entry must not be deleted, or None. Checked again just before every move."""
    allowed = library.places.get(entry.root)
    unfit = "not learned memory" if LEARNED in library.kinds else "not a rule or skill"
    if entry.kind not in library.kinds or not entry.deletable or entry.path is None or allowed is None:
        return unfit
    root = entry.root
    if not entry.path.startswith(root + os.sep):
        return "outside the agent folder"
    if entry.path[len(root) + 1:].split(os.sep)[0] not in allowed:
        return unfit
    if not os.path.lexists(entry.path):
        return "already gone"
    if entry.link is None:
        if os.path.realpath(entry.path) != entry.path:
            return "reached through a symlink"
    elif not os.path.islink(entry.path) or os.path.realpath(root) != root:
        return "reached through a symlink"  # a link moves alone, and only if it is still the link we listed
    return None


def trash_locations(home):
    """Where the Trash lives: ~/.Trash on macOS, the freedesktop Trash elsewhere."""
    if sys.platform == "darwin":
        return os.path.join(home, ".Trash"), None
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    return os.path.join(data, "Trash", "files"), os.path.join(data, "Trash", "info")


def move_to_trash(path, home, label, now=None):
    files, info = trash_locations(home)
    os.makedirs(files, mode=0o700, exist_ok=True)
    if info:
        os.makedirs(info, mode=0o700, exist_ok=True)
    base = "%s-%s" % (label, os.path.basename(path))
    name = base
    number = 1
    while os.path.lexists(os.path.join(files, name)) or (
        info and os.path.lexists(os.path.join(info, name + ".trashinfo"))
    ):
        number += 1
        name = "%s %d" % (base, number)
    target = os.path.join(files, name)
    record = None
    if info:
        record = os.path.join(info, name + ".trashinfo")
        deleted = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now))
        with open(record, "x") as handle:
            handle.write("[Trash Info]\nPath=%s\nDeletionDate=%s\n" % (quote(path), deleted))
    try:
        shutil.move(path, target)
    except (OSError, shutil.Error):
        if record:
            try:
                os.remove(record)
            except OSError:
                pass
        raise
    return target


def trash_label(entry):
    """A name for the Trash that says which agent and project the memory came from."""
    agent = re.sub(r"[^A-Za-z0-9_.-]+", "", entry.agent or "").lstrip(".") or "agent"
    return "%s-%s" % (agent, os.path.basename(entry.root).lstrip(".")[-60:])


def run_plan(plan, library, now=None):
    """Move every item to the Trash. Returns the entries moved and (entry, reason) failures."""
    moved = []
    failed = []
    for entry in plan.items:
        reason = refusal(entry, library)
        if reason is None:
            try:
                move_to_trash(entry.path, library.home, trash_label(entry), now)
            except (OSError, shutil.Error) as error:
                reason = str(error)
        if reason is None:
            moved.append(entry)
        else:
            failed.append((entry, reason))
    return moved, failed


# --- Reading a file --------------------------------------------------------------------

Document = namedtuple("Document", "text size truncated")


def read_document(path):
    """The first part of a text file as a Document, or a reason (a string) it cannot be shown."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        if os.path.islink(path):
            return "is a symlink, which is not followed"
        return "cannot be opened (%s)" % (error.strerror or "error")
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return "is not a regular file"
        data = b""
        while len(data) <= MAX_VIEW:
            chunk = os.read(descriptor, MAX_VIEW + 1 - len(data))
            if not chunk:
                break
            data += chunk
    except OSError as error:
        return "cannot be read (%s)" % (error.strerror or "error")
    finally:
        os.close(descriptor)
    truncated = len(data) > MAX_VIEW
    data = data[:MAX_VIEW]
    unreadable = "is not readable text (a %s file)" % format_size(info.st_size)
    if b"\0" in data[:8192]:
        return unreadable
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        if not truncated or error.start < len(data) - 4:
            return unreadable
        text = data[: error.start].decode("utf-8")
    return Document(text, info.st_size, truncated)


def clean_line(line):
    """A line fit for the screen: tabs expanded and control characters made visible."""
    line = line.replace("\r", "").expandtabs(4)
    return "".join(char if char.isprintable() else "·" for char in line)


class Viewer(object):
    """A read-only view of one text file, or of the warning about a broken link."""

    def __init__(self, entry, trail, document, warning=False):
        self.entry = entry
        self.trail = trail
        self.document = document
        self.warning = warning
        self.top = 0
        self.page = 10
        self.max_top = 1 << 30  # the last position that still fills the view; known after a draw
        name = entry.name.lower()
        self.kind = "jsonl" if name.endswith((".jsonl", ".ndjson")) else "json" if name.endswith(".json") else "text"
        self.pretty = self.kind == "json"
        self.cache = {}

    def can_pretty(self):
        return self.kind in ("json", "jsonl")

    def lines(self):
        text = self.document.text
        if self.pretty and self.kind == "json":
            try:
                text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
            except ValueError:
                pass
        lines = text.split("\n")
        if self.pretty and self.kind == "jsonl":
            spread = []
            for line in lines:
                try:
                    value = json.loads(line)
                except ValueError:
                    spread.append(line)
                    continue
                if isinstance(value, (dict, list)):
                    spread.extend(json.dumps(value, indent=2, ensure_ascii=False).split("\n"))
                    spread.append("")
                else:
                    spread.append(line)
            lines = spread
        return [clean_line(line) for line in lines]

    def wrapped(self, width):
        """(line number or None, text) for every row, long lines broken to the width."""
        key = (self.pretty, width)
        if key not in self.cache:
            rows = []
            for number, line in enumerate(self.lines(), 1):
                pieces = [line[start:start + width] for start in range(0, len(line), width)] or [""]
                for index, piece in enumerate(pieces):
                    rows.append((number if index == 0 else None, piece))
            self.cache = {key: rows}
        return self.cache[key]


# --- The screen ------------------------------------------------------------------------


class Dialog(object):
    """The preview shown before anything is deleted, with a y/N question."""

    def __init__(self, plan):
        self.plan = plan
        self.top = 0  # the first line of the list that is shown
        self.page = 1  # how many lines of it fit, set when it is drawn
        self.max_top = 0


class Browser(object):
    """What is on screen and what each key does, with no curses in it."""

    def __init__(self, library, loader=None, clock=time.time, ascii_only=False, rules=None, rules_loader=None):
        self.library = library
        self.loader = loader
        self.clock = clock
        self.chars = ASCII_CHARS if ascii_only else UNICODE_CHARS
        self.stack = [library.root]
        self.memory = {}  # folder names -> the row the cursor was on
        self.scroll = {}  # folder names -> the first row shown
        self.tab = 1  # 0 disk, 1 memory, 2 rules
        self.has_rules = rules is not None
        self.saved = {}  # the place of each tab that is not on screen
        if rules is not None:
            self.saved[2] = {
                "library": rules, "loader": rules_loader, "stack": [rules.root], "memory": {}, "scroll": {},
            }
        self.message = ""
        self.dialog = None
        self.viewer = None
        self.running = True
        self.page = 5

    # State

    @property
    def node(self):
        return self.stack[-1]

    def key(self):
        return tuple(entry.name for entry in self.stack[1:])

    def rows(self):
        return self.node.visible()

    def index(self):
        name = self.memory.get(self.key())
        for number, row in enumerate(self.rows()):
            if row.name == name:
                return number
        return 0

    def current(self):
        rows = self.rows()
        return rows[self.index()] if rows else None

    def select(self, number):
        rows = self.rows()
        if not rows:
            return
        self.memory[self.key()] = rows[max(0, min(len(rows) - 1, number))].name

    def move(self, delta):
        self.select(self.index() + delta)

    def step(self, delta):
        """One row up or down, going round: below the last row comes the first, and the reverse."""
        count = len(self.rows())
        if count:
            self.select((self.index() + delta) % count)

    def switch(self, new):
        """Show another tab; each list tab keeps its own folder and cursors."""
        if new == self.tab:
            return
        if new == 2 and not self.has_rules:
            self.message = "The rules tab is not available."
            return
        if self.tab in (1, 2):
            self.saved[self.tab] = {
                "library": self.library, "loader": self.loader, "stack": self.stack,
                "memory": self.memory, "scroll": self.scroll,
            }
        self.tab = new
        if new in self.saved:
            for name, value in self.saved[new].items():
                setattr(self, name, value)

    def open(self):
        entry = self.current()
        if entry is None:
            return
        if entry.always and not entry.visible():
            self.message = (
                "%s has no folder here: nothing to open." if entry.missing
                else "%s has no " + self.library.what + " yet: nothing to open."
            ) % entry.name
        elif not entry.is_dir:
            self.open_file(entry)
        elif entry.visible():
            self.stack.append(entry)
        else:
            self.message = entry.note or "Nothing to open: every entry in this folder is empty."

    def open_file(self, entry):
        if entry.broken:
            if points_nowhere(entry.path):  # looked at again now, not as it was at the scan
                home = self.library.home
                text = (
                    "This symlink is broken: the file it points to was not found.\n\n"
                    "  link    %s\n  target  %s\n\n"
                    "Nothing was changed. Fix it yourself, or press D on its row to move the link to the Trash."
                ) % (tilde(entry.path, home), tilde(entry.link, home))
                trail = [item.name for item in self.stack[1:]] + [entry.name]
                self.viewer = Viewer(entry, trail, Document(text, 0, False), warning=True)
                return
            self.reload()  # it was mended since the scan: read it as any link
        if entry.text is not None:
            document = Document(entry.text, len(entry.text.encode("utf-8")), False)
        else:
            document = read_document(os.path.realpath(entry.path) if entry.link else entry.path)
        if isinstance(document, str):
            self.message = "%s %s." % (entry.name, document)
            return
        trail = [item.name for item in self.stack[1:]] + [entry.name]
        self.viewer = Viewer(entry, trail, document)

    def back(self):
        if len(self.stack) > 1:
            self.stack.pop()

    def reload(self):
        """Scan again and return to the same place, or the nearest one that still exists."""
        if self.loader is None:
            return
        names = [entry.name for entry in self.stack[1:]]
        before = self.index()
        row = self.memory.get(self.key())
        self.library = self.loader()
        stack = [self.library.root]
        for name in names:
            match = next((c for c in stack[-1].visible() if c.name == name), None)
            if match is None:
                break
            stack.append(match)
        while len(stack) > 1 and not stack[-1].visible():
            stack.pop()
        self.stack = stack
        if len(stack) - 1 == len(names) and row not in [r.name for r in self.rows()]:
            self.select(before)  # the row is gone: stay near where it was

    # Deleting

    def begin_delete(self):
        """Preview moving what the cursor is on to the Trash: an agent, a folder, a file or a link."""
        scope = self.current()
        library = self.library
        if scope is None:
            self.message = "Nothing is selected."
            return
        if scope.always and scope.size <= 0 and not scope.alerts:
            self.message = (
                "%s has no folder here: nothing to delete." if scope.missing
                else "%s has no " + library.what + " yet: nothing to delete."
            ) % scope.name
            return
        items = []
        seen = set()
        for item in prunable(scope):
            if (item.size > 0 or item.broken) and item.path not in seen:
                seen.add(item.path)
                items.append(item)
        if not items:
            self.message = 'Nothing to delete in "%s": generated indexes and databases are read-only.' % scope.name
            return
        links = [item for item in items if item.link is not None]
        kept = scope.size - sum(item.size for item in items) + sum(item.size for item in links)
        memory = LEARNED in library.kinds
        plan = Plan(
            'Delete %s of "%s"' % (library.noun, scope.name), items, kept, dangling_links(items, library),
            "kept (read-only)" if memory else "targets that stay", memory or bool(links),
        )
        self.dialog = Dialog(plan)

    def confirm_delete(self):
        plan = self.dialog.plan
        self.dialog = None
        moved, failed = run_plan(plan, self.library, self.clock())
        real = [entry for entry in moved if entry.link is None]
        links = len(moved) - len(real)
        counts = []
        if real:
            counts.append("%d item%s" % (len(real), "" if len(real) == 1 else "s"))
        if links:
            counts.append("%d link%s" % (links, "" if links == 1 else "s"))
        if real:
            text = "Moved %s to the Trash (%s)." % (format_size(sum(entry.size for entry in real)), ", ".join(counts))
        else:
            text = "Moved %s to the Trash." % ", ".join(counts)
        if plan.breaks and moved:
            text += " %d link%s now point%s at nothing." % (
                len(plan.breaks), "" if len(plan.breaks) == 1 else "s", "s" if len(plan.breaks) == 1 else "")
        if failed:
            text += " Could not move %d: %s: %s." % (len(failed), failed[0][0].name, failed[0][1])
        self.reload()
        self.message = text

    def dialog_key(self, key):
        dialog = self.dialog
        if key == "resize":
            return
        if key in ("y", "Y"):
            self.confirm_delete()
        elif key in ("esc", "n", "N", "enter"):
            self.dialog = None
            self.message = "Cancelled. Nothing was deleted."
        elif key == "q":
            self.dialog = None
            self.running = False  # nothing has moved
        elif key in ("up", "k"):
            dialog.top = dialog.max_top if dialog.top <= 0 else dialog.top - 1
        elif key in ("down", "j"):
            dialog.top = 0 if dialog.top >= dialog.max_top else dialog.top + 1
        elif key == "pageup":
            dialog.top = max(0, dialog.top - dialog.page)
        elif key == "pagedown":
            dialog.top += dialog.page
        elif key in ("home", "g"):
            dialog.top = 0
        elif key in ("end", "G"):
            dialog.top = 1 << 30

    # Keys

    def viewer_key(self, key):
        viewer = self.viewer
        self.message = ""
        if key == "resize":
            return
        if key in ("left", "esc", "backspace", "h"):
            self.viewer = None
        elif key == "q":
            self.running = False
        elif key in ("up", "k"):
            viewer.top = viewer.max_top if viewer.top <= 0 else viewer.top - 1
        elif key in ("down", "j"):
            viewer.top = 0 if viewer.top >= viewer.max_top else viewer.top + 1
        elif key == "pageup":
            viewer.top = max(0, viewer.top - viewer.page)
        elif key in ("pagedown", " "):
            viewer.top += viewer.page
        elif key in ("home", "g"):
            viewer.top = 0
        elif key in ("end", "G"):
            viewer.top = 1 << 30
        elif key == "p":
            if viewer.can_pretty():
                viewer.pretty = not viewer.pretty
                viewer.top = 0
            else:
                self.message = "Only .json and .jsonl files can be pretty-printed."
        elif key in ("D", "d"):
            self.message = "The viewer is read-only. Press Left to go back."

    def handle_key(self, key):
        if self.dialog is not None:
            self.dialog_key(key)
            return
        if self.viewer is not None:
            self.viewer_key(key)
            return
        self.message = ""
        if key == "q":
            self.running = False
        elif key in ("1", "2", "3"):
            self.switch(int(key) - 1)
        elif key == "tab":
            order = [0, 1] + ([2] if self.has_rules else [])
            self.switch(order[(order.index(self.tab) + 1) % len(order)])
        elif self.tab == 0:
            return
        elif key in ("up", "k"):
            self.step(-1)
        elif key in ("down", "j"):
            self.step(1)
        elif key == "pageup":
            self.move(-self.page)
        elif key == "pagedown":
            self.move(self.page)
        elif key in ("home", "g"):
            self.select(0)
        elif key in ("end", "G"):
            self.select(len(self.rows()))
        elif key in ("right", "enter", "l"):
            self.open()
        elif key in ("left", "backspace", "h"):
            self.back()
        elif key == "r":
            self.reload()
            self.message = "Scanned again."
        elif key in ("d", "D"):
            self.begin_delete()

    # Drawing: each line is a list of (text, style) pieces that add up to the screen width.

    def boxed(self, spans, inner):
        total = sum(len(text) for text, _ in spans)
        if total < inner:
            spans = spans + [(" " * (inner - total), "normal")]
        elif total > inner:
            cut = []
            room = inner
            for text, style in spans:
                if room <= 0:
                    break
                cut.append((text[:room], style))
                room -= len(text[:room])
            spans = cut
        wall = self.chars["v"]
        return [(wall, "dim")] + spans + [(wall, "dim")]

    def rule(self, left, right, width, title=""):
        chars = self.chars
        head = chars["h"] + (" %s " % title if title else "")
        text = chars[left] + head + chars["h"] * (width - 2 - len(head)) + chars[right]
        return [(text, "dim")]

    def columns(self, inner):
        return inner - 41

    def cells(self, entry, name_width):
        now = self.clock()
        text = entry.name
        if entry.link:
            text = "%s %s %s" % (entry.name, self.chars["right"], tilde(entry.link, self.library.home))
        name = fit(text, name_width, self.chars, tail=not entry.link)
        status = entry_status(entry).ljust(7)
        if entry.size <= 0:
            return name, "-".rjust(9), "-".rjust(9), "-".rjust(4), status
        return (
            name,
            format(entry.paths, ",").rjust(9),
            format_size(entry.size).rjust(9),
            format_age(now - entry.mtime).rjust(4),
            status,
        )

    def row(self, entry, selected, inner):
        name, paths, size, age, status = self.cells(entry, self.columns(inner))
        marker = "> " if selected else "  "
        gap = "  "
        line = " " + marker + name + gap + paths + gap + size + gap + age + gap + status + " "
        if selected:
            return [(line, "cursor")]
        if status.strip() == "broken":
            return [(line, "danger")]
        if entry.size <= 0:
            return [(line, "dim")]
        tone = {LEARNED: "ok", SKILLS: "ok", MIXED: "warn", RULES: "dim"}[status.strip()]
        return [
            (" " + marker + name + gap + paths + gap + size + gap + age + gap, "normal"),
            (status, tone),
            (" ", "normal"),
        ]

    def header(self, inner):
        gap = "  "
        text = (
            "   " + "NAME".ljust(self.columns(inner)) + gap + "PATHS".rjust(9) + gap
            + "SIZE".rjust(9) + gap + "AGE".rjust(4) + gap + "TYPE".ljust(7) + " "
        )
        return [(text, "head")]

    def keys(self):
        """The hints under the list: (left group, right group)."""
        chars = self.chars
        if self.tab == 0:
            return "[2] memory" + ("  [3] rules" if self.has_rules else ""), "[q] quit"
        entry = self.current()
        reading = "read" if entry is not None and not entry.is_dir else "open"
        move = "[%s] move  [%s] %s" % (chars["updown"], chars["right"], reading)
        back = "  [%s] back" % chars["left"] if len(self.stack) > 1 else ""
        return "%s%s  [D] delete" % (move, back), "[r] rescan  [q] quit"

    def key_line(self, left, right, inner):
        """One line of hints with the left group at the left edge and the right at the right."""
        room = inner - 2
        gap = room - len(left) - len(right)
        text = left + " " * gap + right if gap >= 2 else fit(left + "  " + right, room, self.chars)
        return self.boxed([(" " + text, "dim")], inner)

    def scanned_text(self):
        age = self.clock() - self.library.scanned_at
        return "scanned just now" if age < 60 else "scanned %s ago" % format_age(age)

    def tab_line(self, inner):
        labels = [(0, "disk"), (1, "memory")] + ([(2, "rules")] if self.has_rules else [])
        tabs = [(" ", "normal")]
        for index, label in labels:
            active = index == self.tab
            tabs.append((("[%d %s]" if active else "%d %s") % (index + 1, label), "tab" if active else "dim"))
            tabs.append(("  ", "normal"))
        used = sum(len(text) for text, _ in tabs)
        right = self.scanned_text() + " "
        tabs.append((" " * max(1, inner - used - len(right)), "normal"))
        tabs.append((right, "dim"))
        return self.boxed(tabs, inner)

    def render(self, width, height):
        if width < MIN_WIDTH or height < MIN_HEIGHT:
            return [[("Terminal too small: need %dx%d, have %dx%d." % (
                MIN_WIDTH, MIN_HEIGHT, width, height), "danger")]]
        if self.dialog is not None:
            return self.render_dialog(width, height)
        if self.viewer is not None:
            return self.render_viewer(width, height)
        inner = width - 2
        chars = self.chars
        rows = self.rows() if self.tab in (1, 2) else []
        list_height = height - 10
        self.page = max(1, list_height - 1)

        total_size = sum(row.size for row in rows)
        total_paths = sum(row.paths for row in rows)
        trail = chars["crumb"].join(entry.name for entry in self.stack)
        summary = ""
        if self.tab in (1, 2) and rows:
            summary = "total %s%s%s paths " % (format_size(total_size), chars["dot"], format(total_paths, ","))
        crumb_width = max(1, inner - len(summary) - 1)
        crumb = " " + fit(trail if self.tab in (1, 2) else "disk", crumb_width, chars, tail=True)

        lines = [
            self.rule("tl", "tr", width, "hub-william"),
            self.tab_line(inner),
            self.rule("ml", "mr", width),
            self.boxed([(crumb, "bold"), (summary, "normal")], inner),
            self.rule("ml", "mr", width),
            self.boxed(self.header(inner) if self.tab in (1, 2) else [], inner),
        ]

        if self.tab == 0:
            body = [[(" The disk tab is not available yet. Press 2 to go back.", "dim")]]
        elif not rows:
            body = [[(" Nothing to show here: every entry is empty.", "dim")]]
        else:
            cursor = self.index()
            key = self.key()
            offset = min(self.scroll.get(key, 0), cursor)
            offset = max(offset, cursor - list_height + 1)
            self.scroll[key] = offset
            body = [self.row(row, number == cursor, inner)
                    for number, row in enumerate(rows) if offset <= number < offset + list_height]
        for number in range(list_height):
            lines.append(self.boxed(body[number] if number < len(body) else [], inner))

        status = [(" " + self.message, "danger" if "Could not" in self.message else "normal")]
        lines += [
            self.rule("ml", "mr", width),
            self.boxed(status, inner),
            self.key_line(*self.keys(), inner=inner),
            self.rule("bl", "br", width),
        ]
        return lines

    def render_viewer(self, width, height):
        inner = width - 2
        chars = self.chars
        viewer = self.viewer
        content_height = height - 9
        viewer.page = max(1, content_height - 1)
        document = viewer.document
        size = format_size(document.size)
        info = ("first %s of %s" % (format_size(MAX_VIEW), size) if document.truncated else size) + " "
        if viewer.warning:
            info = "broken link "
        trail = chars["crumb"].join([self.stack[0].name] + viewer.trail)
        crumb = " " + fit(trail, max(1, inner - len(info) - 1), chars, tail=True)

        rows = viewer.wrapped(inner - 8)
        viewer.max_top = max(0, len(rows) - content_height)
        viewer.top = max(0, min(viewer.top, viewer.max_top))
        shown = rows[viewer.top: viewer.top + content_height]
        body = []
        for number, text in shown:
            gutter = ("%6d " % number) if number is not None else " " * 7
            body.append([(" " + gutter, "dim"), (text, "danger" if viewer.warning and number == 1 else "normal")])
        position = " rows %d-%d of %d" % (viewer.top + 1, viewer.top + len(shown), len(rows)) if shown else " empty"

        lines = [
            self.rule("tl", "tr", width, "hub-william"),
            self.tab_line(inner),
            self.rule("ml", "mr", width),
            self.boxed([(crumb, "bold"), (info, "normal")], inner),
            self.rule("ml", "mr", width),
        ]
        for number in range(content_height):
            lines.append(self.boxed(body[number] if number < len(body) else [], inner))
        left = "[%s] move  [%s] back" % (chars["updown"], chars["left"])
        lines += [
            self.rule("ml", "mr", width),
            self.boxed([(" " + (self.message or position.strip()), "normal")], inner),
            self.key_line(left, "[q] quit", inner),
            self.rule("bl", "br", width),
        ]
        return lines

    def render_dialog(self, width, height):
        inner = width - 2
        dialog = self.dialog
        plan = dialog.plan
        chars = self.chars
        home = self.library.home

        def line(text, style="normal"):
            return self.boxed([(" " + fit(text, inner - 2, chars), style)], inner)

        def item_line(entry, size):
            label = "%s  %s" % (entry.agent, tilde(entry.path, home))
            if entry.link:
                label += " %s %s" % (chars["right"], tilde(entry.link, home))
            return ("  " + fit(label, inner - 2 - 2 - 10, chars, tail=True) + " " + size.rjust(9), "normal")

        body = [
            item_line(item, "broken" if item.broken else "link" if item.link else format_size(item.size))
            for item in plan.items
        ]
        if plan.breaks:
            body.append(("Would break %d link%s:" % (len(plan.breaks), "" if len(plan.breaks) == 1 else "s"), "warn"))
            body += [item_line(entry, "") for entry in plan.breaks]

        lines = [self.rule("tl", "tr", width, "delete " + chars["dot"].strip() + " preview"),
                 line(plan.title, "bold"), line("")]
        links = sum(1 for item in plan.items if item.link)
        real = len(plan.items) - links
        counts = []
        if real:
            counts.append("%d item%s, %s paths" % (real, "" if real == 1 else "s", format(plan.paths, ",")))
        if links:
            counts.append("%d link%s" % (links, "" if links == 1 else "s"))
        lines.append(line("  %s  %9s  (%s)" % (
            "will move to the Trash".ljust(22), format_size(plan.size) if real else "-", ", ".join(counts))))
        if plan.show_kept:
            lines.append(line("  %s  %9s" % (plan.kept_label.ljust(22), format_size(plan.kept))))
        lines.append(line(""))

        room = max(1, height - (9 + (1 if plan.show_kept else 0)))
        scrolling = len(body) > room
        if scrolling:
            room = max(1, room - 1)  # one line goes to saying which rows are shown
        dialog.page = room
        dialog.max_top = max(0, len(body) - room)
        dialog.top = max(0, min(dialog.top, dialog.max_top))
        for text, style in body[dialog.top:dialog.top + room]:
            lines.append(line(text, style))
        if scrolling:
            lines.append(line("rows %d-%d of %d" % (dialog.top + 1, dialog.top + room, len(body)), "dim"))

        lines.append(line("Quit any agent that is running first: it may still use these files.", "dim"))
        lines.append(self.boxed([(" Move to the Trash?  [y/N]", "danger")], inner))
        lines.append(self.key_line("[%s] move" % chars["updown"], "[Esc] cancel  [q] quit", inner))
        lines.append(self.rule("bl", "br", width))
        return lines


# --- Plain output and the terminal -----------------------------------------------------


def list_view(library, agent=None):
    """The table without the interface, as lines of text; None when the agent is unknown."""
    node = library.root
    trail = [node.name]
    if agent is not None:
        match = next((child for child in node.visible() if child.name == agent), None)
        if match is None:
            return None
        node = match
        trail.append(node.name)
    rows = node.visible()
    now = time.time()
    if not rows:
        return ["Nothing found under %s." % library.home]
    labels = [row.name if not row.link else "%s -> %s" % (row.name, tilde(row.link, library.home)) for row in rows]
    name_width = min(max(len(label) for label in labels), 56)
    lines = ["%s   total %s, %s paths" % (
        " > ".join(trail), format_size(sum(r.size for r in rows)),
        format(sum(r.paths for r in rows), ","))]
    lines.append("%s  %9s  %9s  %4s  %s" % ("NAME".ljust(name_width), "PATHS", "SIZE", "AGE", "TYPE"))
    for row, label in zip(rows, labels):
        if row.size <= 0:
            paths = size = age = "-"
        else:
            paths, size, age = format(row.paths, ","), format_size(row.size), format_age(now - row.mtime)
        lines.append("%s  %9s  %9s  %4s  %s" % (
            fit(label, name_width, ASCII_CHARS, tail=not row.link), paths, size, age, entry_status(row)))
    return lines


def modified_key(final, modifier):
    """The key for a modified arrow, Home or End: with Ctrl, Alt or Cmd it jumps to the top or end."""
    jump = bool((modifier - 1) & 0b1110)  # xterm modifiers: 1 Shift, 2 Alt, 4 Ctrl, 8 Meta or Cmd
    return {
        "A": "home" if jump else "up", "B": "end" if jump else "down",
        "C": "right", "D": "left", "H": "home", "F": "end",
    }.get(final)


def parse_escape(sequence):
    """A key from the characters that followed an Escape, or None for one we do not know."""
    match = re.match(r"^[\[O](?:(\d+)(?:;(\d+))?)?([A-Za-z~])$", sequence)
    if not match:
        return None
    number, modifier, final = match.groups()
    if final == "~":
        return {"1": "home", "7": "home", "4": "end", "8": "end", "5": "pageup", "6": "pagedown"}.get(number)
    return modified_key(final, int(modifier) if modifier else 1)


def translate(code):
    """A curses key code as the name Browser.handle_key takes."""
    named = {
        curses.KEY_UP: "up", curses.KEY_DOWN: "down", curses.KEY_LEFT: "left",
        curses.KEY_RIGHT: "right", curses.KEY_ENTER: "enter", curses.KEY_BACKSPACE: "backspace",
        curses.KEY_PPAGE: "pageup", curses.KEY_NPAGE: "pagedown", curses.KEY_HOME: "home",
        curses.KEY_END: "end", curses.KEY_RESIZE: "resize",
        10: "enter", 13: "enter", 27: "esc", 127: "backspace", 8: "backspace", 9: "tab",
    }
    if code in named:
        return named[code]
    if 32 <= code <= 126:
        return chr(code)
    if code > 255:  # a modified key the terminal database knows, such as kUP5 for Ctrl+Up
        match = re.match(r"^k(UP|DN|HOM|END|LFT|RIT)(\d*)$", curses.keyname(code).decode("ascii", "replace"))
        if match:
            final = {"UP": "A", "DN": "B", "HOM": "H", "END": "F", "LFT": "D", "RIT": "C"}[match.group(1)]
            return modified_key(final, int(match.group(2)) if match.group(2) else 1)
    return None


def read_key(screen):
    """The next key. An Escape followed at once by more is one key we may not know; swallow it."""
    code = screen.getch()
    if code != 27:
        return translate(code)
    screen.timeout(30)
    try:
        rest = []
        while len(rest) < 32:
            following = screen.getch()
            if following == -1:
                break
            rest.append(following)
    finally:
        screen.timeout(-1)
    if not rest:
        return "esc"
    return parse_escape("".join(chr(code) for code in rest if 0 < code < 256))


def make_styles():
    styles = {
        "normal": 0, "dim": curses.A_DIM, "bold": curses.A_BOLD, "head": curses.A_BOLD,
        "cursor": curses.A_REVERSE, "tab": curses.A_REVERSE | curses.A_BOLD,
        "ok": curses.A_BOLD, "warn": curses.A_BOLD, "danger": curses.A_BOLD,
    }
    if curses.has_colors():
        try:
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_RED, -1)
            curses.init_pair(2, curses.COLOR_GREEN, -1)
            curses.init_pair(3, curses.COLOR_YELLOW, -1)
            styles["danger"] = curses.color_pair(1) | curses.A_BOLD
            styles["ok"] = curses.color_pair(2)
            styles["warn"] = curses.color_pair(3)
        except curses.error:
            pass
    return styles


def draw(screen, lines, styles):
    height, width = screen.getmaxyx()
    screen.erase()
    for y, spans in enumerate(lines[:height]):
        x = 0
        for text, style in spans:
            room = width - x
            if room > 0:
                try:
                    screen.addstr(y, x, text[:room], styles.get(style, 0))
                except curses.error:
                    pass  # writing the last cell of the screen draws it, then cannot move on
            x += len(text)
    screen.refresh()


def run_screen(screen, home, ascii_only):
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    styles = make_styles()

    def announce(name):
        draw(screen, [[("Scanning %s ..." % name, "normal")]], styles)

    browser = Browser(
        load(home, progress=announce), lambda: load(home), ascii_only=ascii_only,
        rules=load_rules(home, progress=announce), rules_loader=lambda: load_rules(home),
    )
    while browser.running:
        height, width = screen.getmaxyx()
        draw(screen, browser.render(width, height), styles)
        key = read_key(screen)
        if key:
            browser.handle_key(key)


def attach_terminal():
    """Give curses a keyboard when the script itself arrived on stdin (curl | python3)."""
    if not sys.stdout.isatty():
        return False
    if sys.stdin.isatty():
        return True
    try:
        descriptor = os.open("/dev/tty", os.O_RDONLY)
    except OSError:
        return False
    os.dup2(descriptor, 0)
    os.close(descriptor)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="memory",
        description="See and manage what your coding agents remember, and move learned memory to the Trash.",
    )
    parser.add_argument("--list", action="store_true", help="print the table and exit; changes nothing")
    parser.add_argument("--agent", metavar="NAME", help="with --list: show the memory of one agent")
    parser.add_argument("--tab", choices=("memory", "rules"), default="memory", help="with --list: which tab to print")
    parser.add_argument("--home", metavar="PATH", help="scan this home folder instead of yours")
    args = parser.parse_args(argv)
    home = os.path.abspath(os.path.expanduser(args.home or "~"))

    if args.list or args.agent:
        lines = list_view(load_rules(home) if args.tab == "rules" else load(home), args.agent)
        if lines is None:
            print("memory: no agent named %r under %s" % (args.agent, home), file=sys.stderr)
            return 2
        print("\n".join(lines))
        return 0

    if curses is None or not attach_terminal():
        print("memory needs a terminal on macOS or Linux. Use --list to print the table.", file=sys.stderr)
        return 2
    try:
        locale.setlocale(locale.LC_ALL, "")
    except locale.Error:
        pass
    ascii_only = "utf" not in (locale.getpreferredencoding(False) or "").lower()
    os.environ.setdefault("ESCDELAY", "25")
    curses.wrapper(run_screen, home, ascii_only)
    return 0


if __name__ == "__main__":
    sys.exit(main())
