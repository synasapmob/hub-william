#!/usr/bin/env python3
# memory: see what your coding agents remember and are told, and check your disk for risky files
#
# A terminal browser with three tabs, for Claude Code, Codex, Grok and agy. memory lists the
# lessons they save about you; rules lists the instruction files you write for them (CLAUDE.md,
# AGENTS.md, GEMINI.md), their rule folders and their skills; disk is a quick, read-only triage of
# the places where risky files usually land (Downloads, Documents, Desktop, Applications, the
# agents' own folders, login items and /tmp). Each place shows its size, how many files it holds
# and when it last changed, and you can open a folder to look inside and read a file. The disk tab
# gives each file a kind (ok, unknown, suspicious or maybe malware) and the reasons, never a verdict,
# and never runs a file. On the other two tabs d moves what you pick to the Trash: learned memory,
# rule files, skills and links. It never edits what a file says, nothing is ever deleted for good,
# and the indexes and databases an agent generates are never changed.
#
# Nothing leaves your computer, with one optional exception: if VT_API_KEY is set and you answer
# yes to one question, the SHA-256 hashes of the files it flagged (never the files, never their
# names) are looked up at VirusTotal. Without a key, or without a yes, nothing is sent.
#
# Run it from Hub William (it writes only under your home folder, apart from a Linux Trash under
# $XDG_DATA_HOME, and needs a terminal on macOS or Linux with Python 3.9 or newer):
#   curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/memory/memory.py | python3
# Or run a downloaded copy: python3 memory.py
# Print a table without the interface, changing nothing: python3 memory.py --list [--tab=disk]
# Deeper disk checks: --deep (a known-bad hash list from --hashes FILE, YARA with --rules FILE, ClamAV)
# and --online (the VirusTotal lookup).
#
# Keys: 1, 2 and 3 (or Tab) switch tabs, arrows or h j k l move, Right or Enter opens a folder or
# reads a file, Left goes back, d moves what is under the cursor to the Trash after a preview and
# a y/N question (not on the disk tab), r scans again (on the disk tab it also runs the slower
# checks), s sorts the files of a disk place by size, q quits. Each folder remembers where the
# cursor was while the tool runs; a new run starts from the top.

import argparse
import errno
import hashlib
import heapq
import json
import locale
import math
import os
import plistlib
import pwd
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import namedtuple
from urllib.parse import quote

try:
    import curses
except ImportError:  # Windows ships no curses
    curses = None

RULES = "rules"  # instruction files that you write: never edited, and only the rules tab may move one to the Trash
LEARNED = "memory"  # what an agent saved by itself
SKILLS = "skills"  # skill folders (a folder with a SKILL.md): only the rules tab may move one to the Trash
MIXED = "mixed"
DISK = "disk"  # a file or place seen by the disk check

# What the disk check calls a file, from least to most worrying.
OK, UNKNOWN, SUSPICIOUS, MALWARE = "ok", "unknown", "suspicious", "maybe malware"
SEVERITY = {OK: 0, UNKNOWN: 1, SUSPICIOUS: 2, MALWARE: 3}

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
        "verdict", "signals", "flagged", "header", "partial",
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
        self.verdict = None  # what the disk check made of a file, or the worst of the files in a place
        self.signals = None  # (weight, text) for each thing the check found in a file; None: it could not look
        self.flagged = 0  # in a place: how many of its files have its verdict
        self.header = None  # "group": a label above some rows, "gap": a blank line; neither can be selected
        self.partial = False  # the count and the size stopped early: there is more than is shown

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

    def __init__(
        self, home, root, places, scanned_at, what="memory files", noun="learned memory", kinds=(LEARNED,),
        disk=False, mock=False,
    ):
        self.home = home
        self.root = root
        self.places = places
        self.scanned_at = scanned_at
        self.what = what  # what an agent with nothing "has no ... yet"
        self.noun = noun  # what a delete preview is about
        self.kinds = kinds  # the only kinds of entry that may be moved to the Trash
        self.disk = disk  # drawn with FILES and KIND columns, and read-only
        self.mock = mock  # made-up findings, for tests and demos
        self.summary = ""  # what the last scan did, for the status line


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


# --- The disk tab ----------------------------------------------------------------------
#
# A quick, read-only triage of the places where risky files usually land. It never runs a file and
# reads at most the first 64 KB of one. The checks that run on every visit to the tab are the file
# name, the first bytes, the place, the text of scripts, and (macOS) the code signature. The ones that
# run when you press r are a known-bad hash list, YARA and ClamAV if they are installed, and, only
# if you say yes, a lookup of hashes at VirusTotal. A result says what was found, never "this is a
# virus": a clean result is not proof, and a hit may be a harmless file.

KNOWN = 9  # an antivirus rule or a known-bad hash: a finding, not a hint
STRONG, MEDIUM, WEAK = 3, 2, 1  # how much a thing the check found counts
WEIGHT_WORD = {KNOWN: "known", STRONG: "strong", MEDIUM: "medium", WEAK: "weak"}

HEAD = 64 * 1024  # how much of a file is read
MAX_HASH = 64 * 1024 * 1024  # the biggest file that is hashed
PLACE_FILES = 3000  # the most files looked at in one place
PLACE_SECONDS = 8.0  # the longest a place may take
QUICK_SECONDS = 60.0  # the longest a quick scan may take
DEEP_SECONDS = 60.0  # the longest the hashing may take
TOOL_SECONDS = 120  # the longest YARA or ClamAV may take on one place
ENGINE_SECONDS = 240  # the longest they may take together
OS_CHECKS = 40  # the most files whose signature is read in one scan
VT_URL = "https://www.virustotal.com/api/v3"


def judge(signals):
    """What a file is called from what a quick check found in it, as (kind, score).

    A signal is (weight, text). A known-bad finding, or two strong signals together, is "maybe
    malware"; a score of 3 or more is "suspicious", which one strong signal reaches alone. One weak
    or medium signal is not enough: this is a triage, and a name or a download flag proves nothing.
    """
    strong = sum(1 for weight, _ in signals if weight == STRONG)
    score = sum(weight for weight, _ in signals)
    if strong >= 2 or any(weight == KNOWN for weight, _ in signals):
        return MALWARE, score
    if score >= 3:
        return SUSPICIOUS, score
    return OK, score


DOC_EXTS = frozenset(
    "pdf doc docx xls xlsx ppt pptx rtf jpg jpeg png gif heic webp bmp tif tiff mp3 mp4 mov avi mkv wav m4a "
    "csv pages numbers key odt ods".split()
)
TEXT_EXTS = frozenset("txt md json yaml yml toml xml html css log ini cfg conf plist".split())
EXEC_EXTS = frozenset("exe scr com bat cmd vbs js jar command sh pkg dmg msi ps1 apk hta lnk scpt app".split())
RISKY_EXTS = frozenset("command scpt pkg dmg jar exe dll msi bat cmd vbs ps1 apk scr hta app iso".split())
PROGRAMS = ("macho", "elf", "pe")  # what the first bytes say a program is
KIND_WORDS = {
    "macho": "a macOS program", "elf": "a Linux program", "pe": "a Windows program", "script": "a script",
    "java": "a Java class", "pdf": "a PDF", "image": "an image", "zip": "a zip archive", "gzip": "a gzip archive",
    "text": "text", "data": "binary data", "app": "an application bundle",
}
BAIT = re.compile(r"(?i)(?<![a-z])(?:crack(?:ed)?|keygen|warez|activator|patcher|nulled)(?![a-z])")
SKIP_FILES = frozenset((".DS_Store", ".localized", "desktop.ini", "Thumbs.db"))
SKIP_DIRS = frozenset(("node_modules", ".git", "__pycache__", ".venv", ".Trash"))
STARTUP_FILES = (
    ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".profile",
    ".config/fish/config.fish",
)
WORKSPACE, APPLICATIONS, AGENTS, STARTUP, TEMP = "WORKSPACE", "APPLICATIONS", "AGENTS", "SHELL & STARTUP", "TEMP"
GROUPS = (WORKSPACE, APPLICATIONS, AGENTS, STARTUP, TEMP)  # the order of the labels on the first screen
# A place too big to read file by file (Documents) is counted by size and name only, for a while, and shown
# with the files that are biggest or have an odd name. An application is one entry with its bundle's size.
INVENTORY_TOP = 40  # how many of the biggest files are kept
INVENTORY_FLAGS = 100  # how many files with an odd name are kept
INVENTORY_SECONDS = 5.0  # how long counting may take when you open the tab
INVENTORY_DEEP_SECONDS = 120.0  # and when you press r
BUNDLE_FILES = 200000  # the most files counted inside one application
BUNDLE_SECONDS = 4.0  # the longest sizing one application may take
APP_CHECKS = 200  # the most applications whose signature is read in one scan
VERIFY_SECONDS = 60.0  # the longest checking signatures against files may take when you press r
# What an agent is told or allowed to run: settings, hooks, commands, skills. Never its history.
AGENT_PLACES = (
    (".claude", ((".claude/settings.json", 0), (".claude/settings.local.json", 0), (".claude/hooks", 3),
                 (".claude/commands", 3), (".claude/agents", 3), (".claude/skills", 4))),
    (".codex", ((".codex/config.toml", 0), (".codex/prompts", 3), (".codex/skills", 4))),
    (".gemini", ((".gemini/settings.json", 0), (".gemini/extensions", 3))),
    (".grok", ((".grok/config.toml", 0), (".grok/skills", 4), (".grok/rules", 3))),
    (".agents", ((".agents/AGENTS.md", 0), (".agents/skills", 4))),
)
# The same, inside a project the agents know: only these files, never the rest of the repository.
PROJECT_ITEMS = (
    ("CLAUDE.md", 0), ("CLAUDE.local.md", 0), ("AGENTS.md", 0), ("GEMINI.md", 0), (".mcp.json", 0),
    (".claude/settings.json", 0), (".claude/settings.local.json", 0), (".claude/hooks", 3), (".claude/commands", 3),
    (".claude/agents", 3), (".claude/skills", 4), (".codex/config.toml", 0), (".gemini/settings.json", 0),
)
MAX_PROJECTS = 40
TEMP_FOLDERS = ("/tmp/", "/private/tmp/", "/var/tmp/", "/private/var/tmp/", "/var/folders/", "/private/var/folders/")
HIDDEN_OK = frozenset((".local", ".config", ".cargo", ".nvm", ".pyenv", ".rbenv", ".volta", ".bun", ".deno", ".npm"))

# What the text of a script can give away. Each match is reported by its meaning, never by the text
# that matched: a script may hold a secret.
GAP = r"[^\n]{0,300}"  # a bounded gap: a long hostile line must not make the matching slow
SHELL_AFTER_PIPE = r"\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k|c|fi)?sh\b"
TEXT_PATTERNS = (
    (STRONG, "downloads and runs code (curl or wget piped into a shell or interpreter)", re.compile(
        r"\b(?:curl|wget)\b" + GAP + SHELL_AFTER_PIPE
        + r"|\b(?:ba|z)?sh\s+-c\s+[\"']?\$\(\s*(?:curl|wget)\b"
        + r"|\b(?:curl|wget)\b" + GAP + r"\|\s*(?:python[\d.]*|perl|ruby|node)\b", re.I)),
    (STRONG, "decodes hidden data and runs it (base64)", re.compile(
        r"\bbase64\s+(?:-d|-D|--decode)\b" + GAP + SHELL_AFTER_PIPE
        + r"|\b(?:eval|exec)\b[^\n]{0,120}(?:base64\s+(?:-d|-D|--decode)|b64decode|atob\()", re.I)),
    (STRONG, "opens a reverse shell", re.compile(
        r"/dev/tcp/|\bnc(?:at)?\b" + GAP + r"\s-[ec]\s|\bbash\s+-i\s*>&|\bsocat\b" + GAP + r"\bexec:", re.I)),
    (STRONG, "mentions a crypto-miner pool", re.compile(
        r"stratum\+(?:tcp|ssl)://|\bxmrig\b|--donate-level|cryptonight", re.I)),
)
SENSITIVE = re.compile(
    r"(?:~|\$HOME|/Users/[^/\s]+|/home/[^/\s]+)/\.(?:ssh|aws|gnupg)\b|\.config/gcloud|Library/Keychains|id_rsa|id_ed25519"
    r"|Login Data|logins\.json|\.npmrc|\.netrc", re.I)
UPLOAD = re.compile(
    r"\b(?:curl|wget)\b" + GAP + r"(?:\s-d\s|\s--data\S*|\s-F\s|\s--form\b|\s-T\s|\s--upload-file\b|\s--post-\S+)|\bscp\b|\bsftp\b", re.I)
BLOB = re.compile(r"[A-Za-z0-9+/=]{400,}")


def sniff(head):
    """What the first bytes of a file say it is."""
    if head[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"):
        return "macho"
    if head[:4] == b"\xca\xfe\xba\xbe":  # a fat Mach-O file and a Java class both start so
        return "macho" if int.from_bytes(head[4:8], "big") < 32 else "java"
    if head[:4] == b"\x7fELF":
        return "elf"
    if head[:2] == b"MZ":
        return "pe"
    if head[:2] == b"#!":
        return "script"
    if head[:5] == b"%PDF-":
        return "pdf"
    if head[:8] == b"\x89PNG\r\n\x1a\n" or head[:3] == b"\xff\xd8\xff" or head[:6] in (b"GIF87a", b"GIF89a"):
        return "image"
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        return "zip"
    if head[:2] == b"\x1f\x8b":
        return "gzip"
    return "text" if looks_text(head) else "data"


def looks_text(head):
    if not head:
        return True
    sample = head[:8192]
    if b"\0" in sample:
        return False
    printable = sum(1 for byte in sample if byte in (9, 10, 13) or 32 <= byte < 127 or byte >= 128)
    return printable / float(len(sample)) > 0.95


def entropy(data):
    """How random the bytes look, from 0 to 8: text is around 4 to 5, packed or encrypted data over 7."""
    if not data:
        return 0.0
    counts = {}
    for byte in data:
        counts[byte] = counts.get(byte, 0) + 1
    size = float(len(data))
    return -sum(count / size * math.log(count / size, 2) for count in counts.values())


def read_head(path, size=HEAD):
    """The first bytes of a regular file, or None if it cannot be read. A link or a pipe is not opened."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            return None
        return os.read(descriptor, size)
    except OSError:
        return None
    finally:
        os.close(descriptor)


def check_name(name, kind):
    """Signals in a file's name, and in a name that does not fit the bytes behind it."""
    parts = name.lower().split(".")
    ext = parts[-1] if len(parts) > 1 else ""
    found = []
    if len(parts) >= 3 and parts[-2] in DOC_EXTS and ext in EXEC_EXTS:
        found.append((STRONG, "double extension: .%s.%s" % (parts[-2], ext)))
    if kind in PROGRAMS and (ext in DOC_EXTS or ext in TEXT_EXTS):
        found.append((STRONG, "%s behind a document name" % KIND_WORDS[kind]))
    if ext in RISKY_EXTS:
        found.append((WEAK, "a kind of file that installs or runs code (.%s)" % ext))
    if BAIT.search(name):
        found.append((WEAK, "the name says crack or keygen"))
    return found


def odd_name(name):
    """A name worth a closer look without reading the file: a double extension, or crack and keygen."""
    lowered = name.lower()
    parts = lowered.split(".")
    if len(parts) >= 3 and parts[-2] in DOC_EXTS and parts[-1] in EXEC_EXTS:
        return True
    return any(word in lowered for word in ("crack", "keygen", "warez", "activator", "patcher", "nulled")) and bool(
        BAIT.search(name))


def check_text(text):
    """Signals in the text of a script, a setting or an instruction file."""
    found = [(weight, why) for weight, why, pattern in TEXT_PATTERNS if pattern.search(text)]
    lowered = text.lower()
    if "osascript" in lowered and "hidden answer" in lowered:
        found.append((STRONG, "asks for your password with a fake dialog (osascript)"))
    if SENSITIVE.search(text):
        found.append((STRONG, "reads credential files and uploads data")) if UPLOAD.search(text) else found.append(
            (WEAK, "mentions credential files"))
    if BLOB.search(text) and not any("base64" in why for _, why in found):
        found.append((WEAK, "holds a very long encoded blob"))
    return found


def risky_location(path, home):
    """Where a program lives that a login item starts, if that place is worrying; else None."""
    if path.startswith(("/tmp/", "/private/tmp/", "/var/tmp/", "/private/var/tmp/", "/dev/shm/")):
        return STRONG, "a temp folder"
    if path.startswith(home.rstrip(os.sep) + "/Downloads/"):
        return STRONG, "Downloads"
    if path.startswith(home.rstrip(os.sep) + os.sep):
        first = path[len(home.rstrip(os.sep)) + 1:].split(os.sep)[0]
        if first.startswith(".") and first not in HIDDEN_OK:
            return MEDIUM, "a hidden folder"
    return None


def check_program(program, home):
    """Signals about the program a login item starts."""
    place = risky_location(program, home)
    if place is not None:
        return [(place[0], "starts a program from %s at login" % place[1])]
    if program.startswith("/") and not os.path.exists(program):
        return [(MEDIUM, "starts a program that does not exist")]
    return []


def check_launchd(data, home):
    """Signals in a LaunchAgent or LaunchDaemon plist (the bytes of the file).

    An XML plist is not parsed as XML, which a hostile file could abuse: its program is picked out
    with a strict pattern. A binary plist goes to plistlib, which has no entities to expand.
    """
    program = None
    if data.startswith(b"bplist"):
        try:
            plist = plistlib.loads(data)
        except Exception:  # a plist that cannot be read says nothing about the program
            return [(WEAK, "the plist cannot be read")]
        if isinstance(plist, dict):
            arguments = plist.get("ProgramArguments")
            program = plist.get("Program") or (arguments[0] if isinstance(arguments, list) and arguments else None)
    elif b"<plist" in data[:4096] or data.lstrip().startswith(b"<?xml"):
        found = re.search(rb"<key>Program</key>\s*<string>([^<]{1,1024})</string>", data) or re.search(
            rb"<key>ProgramArguments</key>\s*<array>\s*<string>([^<]{1,1024})</string>", data)
        if found:
            program = found.group(1).decode("utf-8", "replace").replace("&amp;", "&")
    else:
        return [(WEAK, "the plist cannot be read")]
    return check_program(program, home) if isinstance(program, str) else []


def check_unit(text, home):
    """Signals in a Linux autostart entry or a systemd user unit."""
    found = []
    for match in re.finditer(r"^Exec(?:Start)?=(?:-|@)?(\S+)", text, re.M):
        found += check_program(match.group(1), home)
    return found


def check_config(text):
    """Signals in an agent's JSON settings: servers that run an unpinned package or are handed a secret."""
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return []
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    found = []
    for server in (servers.values() if isinstance(servers, dict) else ()):
        if not isinstance(server, dict):
            continue
        arguments = [str(item) for item in server.get("args") or [] if not str(item).startswith("-")]
        if server.get("command") in ("npx", "bunx") and arguments and not re.search(r"@[^/@]+$", arguments[0]):
            found.append((MEDIUM, "an MCP server runs an unpinned package"))
        environment = server.get("env") if isinstance(server.get("env"), dict) else {}
        if any(re.search(r"TOKEN|KEY|SECRET|PASSWORD", name, re.I) and value for name, value in environment.items()):
            found.append((WEAK, "an MCP server is handed a secret"))
    return found


def mac_signature(path, run=subprocess.run, verify=False):
    """What macOS says of a program's signature: (state, detail); state is signed, adhoc, unsigned, invalid or unknown.

    Reading it is quick. Checking it against the file is not (about 2 s for an application), so that
    only happens with verify, which the quick scan does not use.
    """
    try:
        shown = run(["/usr/bin/codesign", "-dvv", path], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return "unknown", "codesign did not answer"
    text = (shown.stderr or "") + (shown.stdout or "")
    if "not signed at all" in text:
        return "unsigned", "not signed"
    if "Signature=adhoc" in text:
        return "adhoc", "signed ad hoc, by no developer"
    if "Authority=" in text:
        who = re.search(r"Authority=([^\n]+)", text)
        detail = who.group(1) if who else "signed"
        if verify and mac_verify(path, run) is False:
            return "invalid", "the signature does not match the file"
        return "signed", detail
    return "unknown", "codesign gave no signature"


def mac_verify(path, run=subprocess.run):
    """Whether a signature matches the file: True, False, or None if codesign gave no answer. Slow."""
    try:
        checked = run(["/usr/bin/codesign", "--verify", "--strict", path], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return checked.returncode == 0


def mac_quarantined(path, run=subprocess.run):
    """Whether macOS marked a file as downloaded from the internet."""
    try:
        return run(["/usr/bin/xattr", "-p", "com.apple.quarantine", path], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def sha256_of(path):
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def load_hashes(path):
    """A list of known-bad SHA-256 hashes, one to a line; a # starts a comment. Raises OSError if unreadable."""
    found = set()
    with open(path) as handle:
        for line in handle:
            word = line.split("#")[0].strip().lower()
            if re.fullmatch(r"[0-9a-f]{64}", word):
                found.add(word)
    return found


# A place: what to call it, what it holds, (path, depth) to look at, its group, and the folder its names are relative to.
Spec = namedtuple("Spec", "label kind items group root", defaults=(None,))


class DiskScanner(object):
    """Looks at the places in turn. Everything it learns stays in memory."""

    def __init__(
        self, home, real=True, system_root="/", bad_hashes=None, rules=None, online_key=None, online_url=VT_URL,
        online_cap=8, run=subprocess.run, urlopen=urllib.request.urlopen, signer=None, quarantine=None,
        clock=time.time, which=shutil.which, verifier=None,
    ):
        self.home = home
        self.real = real  # only the real home is scanned together with /tmp and the system's login items
        self.system_root = system_root
        self.bad_hashes = bad_hashes or set()
        self.rules = rules
        self.online_key = online_key
        self.online_url = online_url
        self.online_cap = online_cap
        self.run = run
        self.urlopen = urlopen
        self.clock = clock
        self.which = which
        darwin = sys.platform == "darwin"
        self.signer = signer if signer is not None else ((lambda path: mac_signature(path, run)) if darwin else None)
        self.quarantine = quarantine if quarantine is not None else (
            (lambda path: mac_quarantined(path, run)) if darwin else None)
        self.verifier = verifier if verifier is not None else (
            (lambda path: mac_verify(path, run)) if darwin else None)
        self.checked = 0  # how many files the system was asked about in this scan
        self.app_checked = 0  # and how many applications
        self.long = False  # count for longer: set while you press r
        self.inventories = {}  # place -> what counting its files found
        self.bundles = {}  # (path, mtime) -> (files, bytes, partial) of an application
        self.signed = {}  # application path -> key, for the signatures that r checks against the files
        self.seen = {}  # (path, size, mtime) -> (kind, signals from the name, the bytes and the text)
        self.os_seen = {}  # the same key -> (signals, detail) from the signature and the download flag
        self.hashes = {}  # the same key -> sha256
        self.deep = {}  # the same key -> signals from the hash list, YARA, ClamAV and the online lookup

    def can_go_online(self):
        return bool(self.online_key)

    def keep(self, key, signal):
        """Remember what a deep check found, once: pressing r again must not count it twice."""
        found = self.deep.setdefault(key, [])
        if signal not in found:
            found.append(signal)

    # Where to look

    def places(self):
        join = lambda *parts: os.path.join(self.home, *parts)
        system = lambda path: os.path.join(self.system_root, path.lstrip("/"))
        places = [
            Spec("~/Documents", "documents", [(join("Documents"), 0)], WORKSPACE),
            Spec("~/Downloads", "downloads", [(join("Downloads"), 4)], WORKSPACE),
            Spec("~/Desktop", "files", [(join("Desktop"), 3)], WORKSPACE),
            Spec("~/Applications", "apps", [(join("Applications"), 1)], APPLICATIONS),
        ]
        for folder, items in AGENT_PLACES:
            places.append(Spec(
                "~/" + folder, "agent", [(join(*name.split("/")), depth) for name, depth in items], AGENTS, join(folder)))
        places += self.project_places()
        places += [
            Spec("shell startup files", "startup", [(join(name), 0) for name in STARTUP_FILES], STARTUP, self.home),
            Spec("~/Library/LaunchAgents", "launch", [(join("Library", "LaunchAgents"), 1)], STARTUP),
            Spec("~/.config/autostart", "launch", [(join(".config", "autostart"), 1)], STARTUP),
            Spec("~/.config/systemd/user", "launch", [(join(".config", "systemd", "user"), 1)], STARTUP),
        ]
        if self.real:
            places += [
                Spec("/Applications", "apps", [(system("/Applications"), 1)], APPLICATIONS),
                Spec("/Library/LaunchAgents", "launch", [(system("/Library/LaunchAgents"), 1)], STARTUP),
                Spec("/Library/LaunchDaemons", "launch", [(system("/Library/LaunchDaemons"), 1)], STARTUP),
                Spec("/tmp", "temp", [(os.path.realpath(system("/tmp")), 2)], TEMP),
                Spec("/var/tmp", "temp", [(os.path.realpath(system("/var/tmp")), 2)], TEMP),
            ]
        return places

    def project_places(self):
        """The projects the agents know, found from Claude's list of them, each with only its agent files."""
        folder = os.path.join(self.home, ".claude", "projects")
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            return []
        found, seen = [], set()
        for name in names:
            path = find_project(name)
            if not path or path in seen or path == self.home or not os.path.isdir(path):
                continue
            if path.startswith(TEMP_FOLDERS) and not path.startswith(self.home.rstrip(os.sep) + os.sep):
                continue  # a scratch folder outside your home is not a project; the TEMP group looks at those
            seen.add(path)
            found.append(Spec(
                tilde(path, self.home), "project", [(os.path.join(path, rel), depth) for rel, depth in PROJECT_ITEMS],
                AGENTS, path))
        return found[:MAX_PROJECTS]

    def walk(self, spec, deadline):
        """The files of a place as (path, name, info, is_app): no link is followed, and the work has limits."""
        base = spec.root
        count = [0]

        def visit(path, depth, root):
            try:
                with os.scandir(path) as scan:
                    entries = sorted(scan, key=lambda entry: entry.name)
            except OSError:
                return
            for entry in entries:
                if count[0] >= PLACE_FILES or self.clock() > deadline:
                    return
                if entry.name in SKIP_FILES or entry.is_symlink():
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        if entry.name.endswith(".app"):
                            count[0] += 1
                            yield entry.path, os.path.relpath(entry.path, root), entry.stat(follow_symlinks=False), True
                        elif depth > 0 and entry.name not in SKIP_DIRS:
                            for found in visit(entry.path, depth - 1, root):
                                yield found
                    elif entry.is_file(follow_symlinks=False):
                        count[0] += 1
                        yield entry.path, os.path.relpath(entry.path, root), entry.stat(follow_symlinks=False), False
                except OSError:
                    continue

        for path, depth in spec.items:
            root = base or path
            if os.path.islink(path):
                continue
            if os.path.isdir(path):
                for found in visit(path, depth, root):
                    yield found
            elif os.path.isfile(path):
                if count[0] >= PLACE_FILES or self.clock() > deadline:
                    return
                try:
                    info = os.lstat(path)
                except OSError:
                    continue
                count[0] += 1
                yield path, os.path.relpath(path, root) if base else os.path.basename(path), info, False

    # What a file looks like

    def examine(self, path, name, spec, info, is_app):
        """(kind, signals) from the name, the first bytes, the place and the text; None if it cannot be read."""
        if is_app:
            return "app", ([] if spec.kind == "apps" else check_name(name, "app"))
        head = read_head(path)
        if head is None:
            return None
        kind = sniff(head)
        found = check_name(os.path.basename(name), kind)
        if spec.kind == "temp" and (kind in PROGRAMS or (kind == "script" and info.st_mode & 0o111)):
            found.append((MEDIUM, "a program in a temp folder"))
        if spec.kind == "downloads" and kind in PROGRAMS:
            found.append((WEAK, "a program in Downloads"))
        ext = os.path.splitext(name)[1].lower().lstrip(".")
        if kind in ("text", "script"):
            text = head.decode("utf-8", "replace")
            found += check_text(text)
            if spec.kind == "launch" and ext in ("plist",):
                found += check_launchd(head if len(head) < HEAD else (read_head(path, 1 << 20) or head), self.home)
            elif spec.kind == "launch":
                found += check_unit(text, self.home)
            if ext in ("json", "") and spec.kind in ("agent", "project"):
                found += check_config(text)
        elif kind == "data" and spec.kind == "launch" and ext == "plist":
            found += check_launchd(read_head(path, 1 << 20) or head, self.home)
        elif kind == "data" and ext in TEXT_EXTS and len(head) >= 4096 and entropy(head) > 7.2:
            found.append((MEDIUM, "looks packed or encrypted but is named like a text file"))
        if spec.kind in ("launch", "startup") and self.clock() - info.st_mtime < 7 * 86400:
            found.append((WEAK, "changed in the last 7 days"))
        return kind, found

    def from_the_system(self, path, key, kind, found, name):
        """Signals from the signature and the download flag, asked of macOS for a file worth the trouble."""
        if key in self.os_seen:
            return self.os_seen[key]
        ext = os.path.splitext(name)[1].lower().lstrip(".")
        signals, detail = [], ""
        app = kind == "app"
        worth = kind in ("macho", "app") or ext in ("pkg", "dmg", "command", "scpt") or bool(found)
        used, limit = (self.app_checked, APP_CHECKS) if app else (self.checked, OS_CHECKS)
        if worth and used < limit and (self.signer or self.quarantine):
            if app:
                self.app_checked += 1
            else:
                self.checked += 1
            if self.signer and (kind in ("macho", "app") or ext == "pkg"):
                state, detail = self.signer(path)
                if state in ("unsigned", "invalid"):
                    signals.append((MEDIUM, "not signed by a known developer" if state == "unsigned" else
                                    "its signature does not match the file"))
                elif state == "adhoc":
                    signals.append((WEAK, "signed ad hoc, by no developer"))
                elif state == "signed" and app:
                    self.signed[path] = key  # r checks it against the files
                detail = "signature  " + detail
            if self.quarantine and (not app or signals) and self.quarantine(path):
                signals.append((WEAK, "downloaded from the internet"))
        self.os_seen[key] = (signals, detail)
        return self.os_seen[key]

    def bundle_stats(self, path, info):
        """How many files an application holds and how many bytes: (files, bytes, partial). Counted once, then kept."""
        key = (path, info.st_mtime_ns)
        if key not in self.bundles:
            started = self.clock()
            files = size = 0
            partial = False
            stack = [path]
            while stack and not partial:
                try:
                    scan = os.scandir(stack.pop())
                except OSError:
                    continue
                with scan:
                    for entry in scan:
                        if files >= BUNDLE_FILES or self.clock() - started > BUNDLE_SECONDS:
                            partial = True
                            break
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(entry.path)
                            elif entry.is_file(follow_symlinks=False):
                                files += 1
                                size += entry.stat(follow_symlinks=False).st_size
                        except OSError:
                            continue
            self.bundles[key] = (files, size, partial)
        return self.bundles[key]

    def count_files(self, root, seconds, progress=None, label=""):
        """Count the files under a folder by stat alone, for a while: what a place too big to read holds."""
        started = last = self.clock()
        files = size = 0
        top, named = [], []
        partial = False
        stack = [root]
        while stack:
            now = self.clock()
            if now - started > seconds:
                partial = True
                break
            if progress is not None and now - last > 0.3:
                last = now
                progress("Counting %s ... %s files" % (label, format(files, ",")))
            try:
                scan = os.scandir(stack.pop())
            except OSError:
                continue
            with scan:
                for entry in scan:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        length = entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
                    files += 1
                    size += length
                    if len(top) < INVENTORY_TOP:
                        heapq.heappush(top, (length, entry.path))
                    elif length > top[0][0]:
                        heapq.heapreplace(top, (length, entry.path))
                    if len(named) < INVENTORY_FLAGS and odd_name(entry.name):
                        named.append(entry.path)
        return {"files": files, "size": size, "partial": partial, "seconds": seconds,
                "top": sorted(top, reverse=True), "named": named}

    def entry_for(self, spec, path, name, info, is_app):
        key = (path, info.st_size, info.st_mtime_ns)
        seen = self.seen.get(key)
        if key not in self.seen:
            seen = self.seen[key] = self.examine(path, name, spec, info, is_app)
        entry = Entry(clean_line(name), path, False, DISK, spec.label)
        entry.size = max(1, info.st_size)
        entry.paths = 1
        entry.mtime = info.st_mtime
        if is_app:  # an application is a folder: its size and its files are what is inside
            files, size, entry.partial = self.bundle_stats(path, info)
            entry.paths, entry.size = files, max(1, size)
        if seen is None:
            entry.verdict = UNKNOWN
            entry.note = "type    could not be read"
            return entry
        kind, found = seen
        extra, detail = self.from_the_system(path, key, kind, found, name)
        entry.signals = found + extra + self.deep.get(key, [])
        entry.verdict = judge(entry.signals)[0]
        digest = self.hashes.get(key)
        entry.note = "\n".join(line for line in (
            "type    %s" % KIND_WORDS.get(kind, kind),
            detail,
            "" if is_app else "sha256  %s" % (digest or "not computed (press r)"),
        ) if line)
        return entry

    def inventory_place(self, spec, progress):
        """A place too big to read: how many files and how big, counted for a while, and its biggest files."""
        root = spec.items[0][0]
        if spec.label not in self.inventories:
            seconds = INVENTORY_DEEP_SECONDS if self.long else INVENTORY_SECONDS
            self.inventories[spec.label] = self.count_files(root, seconds, progress, spec.label)
        stats = self.inventories[spec.label]
        place = Entry(spec.label, None, True, DISK, "disk")
        for path in dict.fromkeys([path for _, path in stats["top"]] + stats["named"]):
            try:
                info = os.lstat(path)
            except OSError:
                continue
            if info.st_size > 0:
                place.add(self.entry_for(spec, path, os.path.relpath(path, root), info, False))
        if place.children:
            settle(place)
            place.size, place.paths, place.partial = stats["size"], stats["files"], stats["partial"]
            place.note = "Biggest and odd-named files: %d of %s%s." % (
                len(place.children), format(stats["files"], ","), "+" if stats["partial"] else "")
            if stats["partial"]:
                place.note += " Count stopped after %d s; r counts longer." % stats["seconds"]
        return place

    # The two kinds of scan

    def quick(self, progress=None):
        """The checks that cost little: name, first bytes, place, script text and signature."""
        self.checked = self.app_checked = 0
        started = self.clock()
        buckets = dict((group, []) for group in GROUPS)
        projects = set()
        for spec in self.places():
            if progress is not None:
                progress("Scanning %s ..." % spec.label)
            if spec.kind == "documents":
                place = self.inventory_place(spec, progress)
            else:
                place = Entry(spec.label, None, True, DISK, "disk")
                deadline = min(self.clock() + PLACE_SECONDS, started + QUICK_SECONDS)
                for path, name, info, is_app in self.walk(spec, deadline):
                    if (info.st_size <= 0 and not is_app) or (spec.kind == "apps" and not is_app):
                        continue
                    if spec.kind == "apps" and progress is not None:
                        progress("Sizing %s ..." % os.path.basename(path))
                    place.add(self.entry_for(spec, path, name, info, is_app))
                if spec.kind == "startup":
                    self.add_crontab(place)
            if place.children:
                settle(place)
                if spec.kind == "project":
                    projects.add(place.name)
                buckets[spec.group].append(place)
        root = Entry("disk")
        rows = []
        files = places = 0
        for group in GROUPS:
            members = sorted(  # the worst first; in a tie an agent comes before a project
                buckets[group], key=lambda one: (-SEVERITY[one.verdict], one.name in projects, -one.size, one.name))
            if not members:
                continue
            gap = Entry("gap %d" % len(rows), None, True, DISK, "disk")  # a blank line above every label, the first too
            gap.header, gap.always = "gap", True
            rows.append(gap)
            rows.append(label_for(group, members))
            for place in members:
                root.add(place)
                rows.append(place)
                files += place.paths
                places += 1
        root.children = rows  # the labels carry no totals of their own, so the root counts each place once
        root.verdict = max((row.verdict for row in rows if not row.header), key=SEVERITY.get, default=OK)
        root.partial = any(row.partial for row in rows if not row.header)
        library = Library(self.home, root, {}, self.clock(), "files", "files", (), disk=True)
        library.summary = "Scanned %s%s file%s in %d place%s" % (
            format(files, ","), "+" if root.partial else "", "" if files == 1 else "s", places, "" if places == 1 else "s")
        return library

    def add_crontab(self, place):
        """Your crontab is a login item too: it is read with crontab -l and shown as one entry."""
        if not self.which("crontab"):
            return
        try:
            shown = self.run(["crontab", "-l"], capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return
        text = shown.stdout if shown.returncode == 0 else ""
        if not text.strip():
            return
        entry = Entry("crontab (your user)", None, False, DISK, "shell startup files")
        entry.size = len(text.encode("utf-8"))
        entry.paths = 1
        entry.mtime = self.clock()
        entry.signals = check_text(text)
        entry.verdict = judge(entry.signals)[0]
        entry.note = "type    your crontab"
        place.add(entry)

    def deepen(self, library, online, progress=None):
        """The checks that cost more: known-bad hashes, YARA, ClamAV and, if allowed, VirusTotal. Returns what was done."""
        files = [node for node in walk(library.root) if not node.is_dir and node.path]
        said = []
        started = self.clock()
        wanted = lambda node: node.verdict in (SUSPICIOUS, MALWARE)
        keys = {}
        for node in files:
            try:
                info = os.lstat(node.path)
            except OSError:
                continue
            keys[node.path] = (node.path, info.st_size, info.st_mtime_ns)
        hashed = 0
        if self.bad_hashes or online:
            for number, node in enumerate(files):
                key = keys.get(node.path)
                if key is None or key[1] > MAX_HASH or (not self.bad_hashes and not wanted(node)):
                    continue
                if self.clock() - started > DEEP_SECONDS:
                    said.append("hashing stopped after %d s" % DEEP_SECONDS)
                    break
                if progress is not None:
                    progress("Hashing %s (%d of %d) ..." % (node.name, number + 1, len(files)))
                if key not in self.hashes:
                    self.hashes[key] = sha256_of(node.path)
                digest = self.hashes[key]
                hashed += 1
                if digest and digest in self.bad_hashes:
                    self.keep(key, (KNOWN, "its SHA-256 is on your known-bad list"))
            said.append("hashed %d file%s" % (hashed, "" if hashed == 1 else "s") if self.bad_hashes
                        else "no hash list (--hashes)")
        else:
            said.append("no hash list (--hashes)")
        said.append(self.verify_apps(progress))
        said.append(self.run_engines(library, keys, progress))
        said.append(self.look_up(files, keys, wanted, progress) if online else "online off")
        return " · ".join(part for part in said if part)

    def verify_apps(self, progress):
        """Check each signed application's signature against its files, which takes about 2 s for each."""
        if not self.verifier or not self.signed:
            return ""
        started = self.clock()
        done = bad = 0
        for number, (path, key) in enumerate(sorted(self.signed.items())):
            if self.clock() - started > VERIFY_SECONDS:
                return "verified %d of %d apps" % (done, len(self.signed))
            if progress is not None:
                progress("Verifying %s (%d of %d) ..." % (os.path.basename(path), number + 1, len(self.signed)))
            valid = self.verifier(path)
            done += 1
            if valid is False:
                self.keep(key, (MEDIUM, "its signature does not match the file"))
                bad += 1
        return "verified %d app%s%s" % (done, "" if done == 1 else "s", ", %d bad" % bad if bad else "")

    def run_engines(self, library, keys, progress):
        """YARA and ClamAV over the folders of the scan, when they are installed."""
        roots = sorted({os.path.dirname(node.path) for node in walk(library.root) if node.path and not node.is_dir})
        folders = [path for path in {self.top(root) for root in roots} if path]
        parts = []
        begun = self.clock()
        rules = self.rules
        yara = self.which("yara")
        if yara and rules:
            hits = 0
            for folder in sorted(folders):
                if self.clock() - begun > ENGINE_SECONDS:
                    break
                if progress is not None:
                    progress("YARA: %s ..." % tilde(folder, self.home))
                for name, path in self.engine_lines([yara, "-r", "-w", rules, folder], r"^(\S+) (/.+)$"):
                    key = keys.get(path)
                    if key:
                        self.keep(key, (KNOWN, "matches the YARA rule %s" % name))
                        hits += 1
            parts.append("YARA: %d hit%s" % (hits, "" if hits == 1 else "s"))
        else:
            parts.append("no YARA" if not yara else "YARA needs --rules")
        clam = self.which("clamscan")
        if clam:
            hits = 0
            for folder in sorted(folders):
                if self.clock() - begun > ENGINE_SECONDS:
                    break
                if progress is not None:
                    progress("ClamAV: %s ..." % tilde(folder, self.home))
                for path, name in self.engine_lines([clam, "-r", "-i", "--no-summary", folder], r"^(/.+): (\S+) FOUND$"):
                    key = keys.get(path)
                    if key:
                        self.keep(key, (KNOWN, "ClamAV calls it %s" % name))
                        hits += 1
            parts.append("ClamAV: %d hit%s" % (hits, "" if hits == 1 else "s"))
        else:
            parts.append("no ClamAV")
        return " · ".join(parts)

    def top(self, folder):
        """The folder of a place that the file belongs to, so that an engine is run once per place."""
        for spec in self.places():
            for path, _ in spec.items:
                if spec.kind in ("downloads", "files", "temp", "launch") and (
                        folder == path or folder.startswith(path.rstrip(os.sep) + os.sep)):
                    return path
        return None

    def engine_lines(self, command, pattern):
        try:
            shown = self.run(command, capture_output=True, text=True, timeout=TOOL_SECONDS)
        except (OSError, subprocess.SubprocessError):
            return
        for line in (shown.stdout or "").splitlines():
            match = re.match(pattern, line)
            if match:
                yield match.groups()

    def look_up(self, files, keys, wanted, progress):
        """Ask VirusTotal about the hashes of flagged files, and nothing else. Stops when it is told to wait."""
        asked = known = 0
        if not self.online_url.lower().startswith(("https://", "http://127.0.0.1", "http://localhost")):
            return "online stopped: the address is not https"
        for node in files:
            if asked >= self.online_cap:
                break
            key = keys.get(node.path)
            digest = self.hashes.get(key) if key else None
            if not digest or not wanted(node):
                continue
            if progress is not None:
                progress("VirusTotal: %d of %d ..." % (asked + 1, self.online_cap))
            request = urllib.request.Request(
                "%s/files/%s" % (self.online_url.rstrip("/"), digest), headers={"x-apikey": self.online_key})
            try:
                with self.urlopen(request, timeout=10) as answer:
                    data = json.loads(answer.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    asked += 1
                    continue  # nobody has seen the file: that says nothing
                return "online stopped: %s" % ("busy" if error.code == 429 else "HTTP %d" % error.code)
            except (OSError, ValueError):
                return "online stopped: no answer"
            asked += 1
            stats = ((data.get("data") or {}).get("attributes") or {}).get("last_analysis_stats") or {}
            bad = int(stats.get("malicious", 0))
            if bad >= 5:
                self.keep(key, (KNOWN, "%d antivirus engines on VirusTotal call it malicious" % bad))
                known += 1
            elif bad >= 1:
                self.keep(key, (MEDIUM, "%d antivirus engine%s on VirusTotal call it malicious" % (
                    bad, "" if bad == 1 else "s")))
        return "VirusTotal: %d asked, %d known bad" % (asked, known)

    def scan(self, deep=False, online=False, progress=None):
        """The library for the disk tab. With deep, the slower checks run first and their findings are kept."""
        if deep:  # the inventories are counted again, for longer, and the bundles sized again
            self.inventories.clear()
            self.bundles.clear()
            self.long = True
        try:
            library = self.quick(progress)
        finally:
            self.long = False
        if not deep:
            return library
        done = self.deepen(library, online and self.can_go_online(), progress)
        library = self.quick(progress)
        library.summary = "%s · %s" % (library.summary, done)
        return library


def label_for(group, places):
    """The label above a group of places: its totals, and the worst kind in it."""
    label = Entry(group, None, True, DISK, "disk")
    label.header, label.always = "group", True
    for place in places:
        label.size += place.size
        label.paths += place.paths
        label.mtime = max(label.mtime, place.mtime)
    label.partial = any(place.partial for place in places)
    label.verdict = max((place.verdict for place in places), key=SEVERITY.get)
    label.flagged = sum(place.flagged for place in places if place.verdict == label.verdict)
    return label


def settle(place):
    """Put the worst first and say what the place as a whole looks like."""
    place.children.sort(key=lambda child: (-SEVERITY[child.verdict], -child.size, child.name))
    worst = max((child.verdict for child in place.children), key=SEVERITY.get, default=OK)
    place.verdict = worst
    place.flagged = sum(child.flagged if child.is_dir else 1 for child in place.children if child.verdict == worst)


def report_text(entry, home, age):
    """What the check found in a file, as the text the viewer shows."""
    if entry.signals is None:
        head = "%s: the check could not read this file" % entry.verdict
        found = ["  It may be locked, or you may not have permission to read it."]
    else:
        kind, score = judge(entry.signals)
        head = "%s  (score %d)" % (kind, score)
        found = ["  %-7s %s" % (WEIGHT_WORD[weight], text) for weight, text in sorted(entry.signals, key=lambda one: -one[0])]
        found = found or ["  Nothing found."]
    return "\n".join(
        [head, ""] + found + [
            "",
            "path    %s" % (clean_line(tilde(entry.path, home)) if entry.path else entry.name),
            "size    %s   changed %s" % (format_size(entry.size), "just now" if age == "now" else age + " ago"),
        ] + (entry.note.split("\n") if entry.note else []) + [
            "",
            "This is a quick check, not a verdict: a clean result is not proof and a hit may be harmless.",
            "The tool never runs a file, and nothing here leaves your computer.",
        ]
    )


def count_text(entry, total=None):
    """A count of files; one that stopped early is shortened and marked: 2.0M+ files."""
    number = entry.paths if total is None else total
    if not entry.partial:
        return format(number, ",")
    if number >= 1000000:
        return "%.1fM+" % (number / 1000000.0)
    return ("%dk+" % (number // 1000)) if number >= 10000 else "%s+" % format(number, ",")


def size_text(entry, total=None):
    return format_size(entry.size if total is None else total) + ("+" if entry.partial else "")


def status_text(entry):
    """The KIND of a row; a place says how many of its files have its kind."""
    status = entry_status(entry)
    if entry.is_dir and entry.flagged and entry.verdict in (SUSPICIOUS, MALWARE):
        return "%s (%d)" % (status, entry.flagged)
    return status


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
    if entry.verdict is not None:
        return entry.verdict  # what the disk check made of it
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

    def __init__(self, entry, trail, document, warning=False, info=None, tone="danger"):
        self.entry = entry
        self.trail = trail
        self.document = document
        self.warning = warning  # the document is a notice or a report, not the file itself
        self.info = info  # what the heading says in place of the file's size
        self.tone = tone  # the colour of its first line
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


class Question(object):
    """Asked once per run, before any hash leaves the computer."""

    def __init__(self, count, cap):
        self.count = count
        self.cap = cap


class Browser(object):
    """What is on screen and what each key does, with no curses in it."""

    def __init__(
        self, library, loader=None, clock=time.time, ascii_only=False, rules=None, rules_loader=None,
        disk=None, disk_loader=None, online_ready=False, online_cap=8,
    ):
        self.library = library
        self.loader = loader
        self.clock = clock
        self.chars = ASCII_CHARS if ascii_only else UNICODE_CHARS
        self.stack = [library.root]
        self.memory = {}  # folder names -> the row the cursor was on
        self.scroll = {}  # folder names -> the first row shown
        self.tab = 1  # 0 disk, 1 memory, 2 rules
        self.has_rules = rules is not None
        self.has_disk = disk is not None or disk_loader is not None  # without it the disk tab is a placeholder
        self.saved = {}  # the place of each tab that is not on screen
        if self.has_disk:
            self.saved[0] = {  # the disk tab is scanned when it is first shown, and again on every visit
                "library": disk, "loader": disk_loader, "stack": [disk.root] if disk else [], "memory": {},
                "scroll": {},
            }
        self.by_size = False  # the disk tab inside a place: biggest first instead of worst first
        self.online_ready = online_ready  # a VirusTotal key is set
        self.online_cap = online_cap
        self.asked = None  # whether hashes may be sent: None until the question is answered
        self.question = None
        self.status = None  # a function that shows a line of text while a scan runs
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
        rows = self.node.visible()
        if self.by_size and self.library.disk and len(self.stack) > 1:
            return sorted(rows, key=lambda row: (-row.size, row.name))
        return rows

    def index(self):
        name = self.memory.get(self.key())
        rows = self.rows()
        for number, row in enumerate(rows):
            if row.name == name and not row.header:
                return number
        return next((number for number, row in enumerate(rows) if not row.header), 0)

    def current(self):
        rows = self.rows()
        return rows[self.index()] if rows else None

    def select(self, number):
        rows = self.rows()
        if not rows:
            return
        number = max(0, min(len(rows) - 1, number))
        if rows[number].header:  # a label or a gap: stand on the nearest row below it, or above if there is none
            below = next((one for one in range(number, len(rows)) if not rows[one].header), None)
            above = next((one for one in range(number, -1, -1) if not rows[one].header), None)
            number = below if below is not None else above
            if number is None:
                return
        self.memory[self.key()] = rows[number].name

    def move(self, delta):
        self.select(self.index() + delta)

    def step(self, delta):
        """One row up or down, going round: below the last row comes the first, and the reverse."""
        rows = self.rows()
        count = len(rows)
        if count:
            number = self.index()
            for _ in range(count):
                number = (number + delta) % count
                if not rows[number].header:
                    break
            self.select(number)

    def is_list(self):
        """Whether the tab on screen is a list of rows, as opposed to the placeholder."""
        return self.tab != 0 or self.has_disk

    def switch(self, new):
        """Show another tab; each list tab keeps its own folder and cursors."""
        if new == self.tab:
            return
        if new == 2 and not self.has_rules:
            self.message = "The rules tab is not available."
            return
        if self.is_list():
            self.saved[self.tab] = {
                "library": self.library, "loader": self.loader, "stack": self.stack,
                "memory": self.memory, "scroll": self.scroll,
            }
        self.tab = new
        if new in self.saved:
            for name, value in self.saved[new].items():
                setattr(self, name, value)
        if new == 0 and self.has_disk:
            self.reload()  # the quick checks run each time you come to the disk tab

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
            if self.library.disk and entry.note:
                self.message = entry.note  # what the place shows, when it shows a part of it
        else:
            self.message = entry.note or "Nothing to open: every entry in this folder is empty."

    def open_file(self, entry):
        if entry.verdict is not None:  # the disk check: a report, not the file
            age = format_age(self.clock() - entry.mtime)
            tone = {MALWARE: "danger", SUSPICIOUS: "warn", UNKNOWN: "dim", OK: "ok"}[entry.verdict]
            trail = [item.name for item in self.stack[1:]] + [entry.name]
            document = Document(report_text(entry, self.library.home, age), 0, False)
            self.viewer = Viewer(entry, trail, document, warning=True, info=entry.verdict, tone=tone)
            return
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

    def notify(self, text):
        if self.status is not None:
            self.status(text)

    def reload(self, **options):
        """Scan again and return to the same place, or the nearest one that still exists."""
        if self.loader is None:
            return
        if self.library is None:  # the disk tab, shown for the first time
            self.library = self.loader(progress=self.notify)
            self.stack = [self.library.root]
            return
        names = [entry.name for entry in self.stack[1:]]
        before = self.index()
        row = self.memory.get(self.key())
        if self.library.disk:
            options["progress"] = self.notify
        self.library = self.loader(**options)
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

    def rescan(self):
        """r: scan again. On the disk tab that also runs the slower checks, and asks first about the online one."""
        if self.loader is None or not self.library.disk:
            self.reload()
            self.message = "Scanned again."
            return
        flagged = sum(1 for node in walk(self.library.root) if not node.is_dir and node.verdict in (SUSPICIOUS, MALWARE))
        if self.online_ready and self.asked is None and flagged:
            self.question = Question(flagged, self.online_cap)
            return
        self.reload(deep=True, online=bool(self.asked))
        self.message = self.library.summary or "Scanned again."

    def question_key(self, key):
        if key == "resize":
            return
        if key == "q":
            self.question = None
            self.running = False  # nothing was sent
        elif key in ("y", "Y", "esc", "n", "N", "enter"):
            self.asked = key in ("y", "Y")
            self.question = None
            self.rescan()

    # Deleting

    def begin_delete(self):
        """Preview moving what the cursor is on to the Trash: an agent, a folder, a file or a link."""
        scope = self.current()
        library = self.library
        if library.disk:
            self.message = "The disk tab only looks: it does not move or delete anything."
            return
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
        if self.question is not None:
            self.question_key(key)
            return
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
        elif not self.is_list():
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
        elif key in ("r", "R"):
            self.rescan()
        elif key in ("s", "S") and self.library.disk and len(self.stack) > 1:
            self.by_size = not self.by_size
            self.message = "Biggest first." if self.by_size else "Worst first."
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

    def kind_width(self):
        return 18 if self.library.disk else 7  # "maybe malware (12)"

    def columns(self, inner):
        return inner - 34 - self.kind_width()

    def cells(self, entry, name_width):
        now = self.clock()
        text = entry.name
        if entry.link:
            text = "%s %s %s" % (entry.name, self.chars["right"], tilde(entry.link, self.library.home))
        name = fit(text, name_width, self.chars, tail=not entry.link)
        status = status_text(entry).ljust(self.kind_width())
        if entry.size <= 0:
            return name, "-".rjust(9), "-".rjust(9), "-".rjust(4), status
        return (
            name,
            count_text(entry).rjust(9),
            size_text(entry).rjust(9),
            format_age(now - entry.mtime).rjust(4),
            status,
        )

    def row(self, entry, selected, inner, indent=False):
        if entry.header == "gap":
            return []
        name, paths, size, age, status = self.cells(entry, self.columns(inner) - (2 if indent else 0))
        if indent:
            name = "  " + name
        marker = "> " if selected else "  "
        gap = "  "
        line = " " + marker + name + gap + paths + gap + size + gap + age + gap + status + " "
        if selected:
            return [(line, "cursor")]
        if status.strip() == "broken":
            return [(line, "danger")]
        if entry.size <= 0:
            return [(line, "dim")]
        label = entry.header == "group"
        tone = {
            LEARNED: "ok", SKILLS: "ok", MIXED: "warn", RULES: "dim",
            OK: "ok", UNKNOWN: "dim", SUSPICIOUS: "warn", MALWARE: "danger",
        }[status.strip().split(" (")[0]]
        return [
            (" " + marker + name + gap + paths + gap + size + gap + age + gap, "head" if label else "normal"),
            (status, tone),
            (" ", "normal"),
        ]

    def header(self, inner):
        gap = "  "
        text = (
            "   " + "NAME".ljust(self.columns(inner)) + gap + ("FILES" if self.library.disk else "PATHS").rjust(9)
            + gap + "SIZE".rjust(9) + gap + "AGE".rjust(4) + gap
            + ("KIND" if self.library.disk else "TYPE").ljust(self.kind_width()) + " "
        )
        return [(text, "head")]

    def keys(self):
        """The hints under the list: (left group, right group)."""
        chars = self.chars
        if not self.is_list():
            return "[2] memory" + ("  [3] rules" if self.has_rules else ""), "[q] quit"
        entry = self.current()
        reading = "read" if entry is not None and not entry.is_dir else "open"
        move = "[%s] move  [%s] %s" % (chars["updown"], chars["right"], reading)
        back = "  [%s] back" % chars["left"] if len(self.stack) > 1 else ""
        sort = "  [S] sort" if self.library.disk and len(self.stack) > 1 else ""
        return "%s%s%s%s" % (move, back, sort, "  [D] delete" if self.library.kinds else ""), "[r] rescan  [q] quit"

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
        mock = self.is_list() and self.library.mock
        right = ("mock data%snot your files" % self.chars["dot"] if mock else self.scanned_text()) + " "
        tabs.append((" " * max(1, inner - used - len(right)), "normal"))
        tabs.append((right, "warn" if mock else "dim"))
        return self.boxed(tabs, inner)

    def render(self, width, height):
        if width < MIN_WIDTH or height < MIN_HEIGHT:
            return [[("Terminal too small: need %dx%d, have %dx%d." % (
                MIN_WIDTH, MIN_HEIGHT, width, height), "danger")]]
        if self.question is not None:
            return self.render_question(width, height)
        if self.dialog is not None:
            return self.render_dialog(width, height)
        if self.viewer is not None:
            return self.render_viewer(width, height)
        inner = width - 2
        chars = self.chars
        rows = self.rows() if self.is_list() else []
        list_height = height - 10
        self.page = max(1, list_height - 1)

        total_size = sum(row.size for row in rows if not row.header)  # a label repeats what is under it
        total_paths = sum(row.paths for row in rows if not row.header)
        more = "+" if any(row.partial for row in rows) else ""  # some count stopped early: these are least numbers
        if self.library.disk and len(self.stack) > 1:  # inside a place the total is the place's, not only the rows shown
            total_size, total_paths, more = self.node.size, self.node.paths, "+" if self.node.partial else ""
        trail = chars["crumb"].join(entry.name for entry in self.stack)
        summary = ""
        if self.is_list() and rows:
            summary = "total %s%s%s%s%s %s " % (
                format_size(total_size), more, chars["dot"], format(total_paths, ","), more,
                "files" if self.library.disk else "paths")
        crumb_width = max(1, inner - len(summary) - 1)
        crumb = " " + fit(trail if self.is_list() else "disk", crumb_width, chars, tail=True)

        lines = [
            self.rule("tl", "tr", width, "hub-william"),
            self.tab_line(inner),
            self.rule("ml", "mr", width),
            self.boxed([(crumb, "bold"), (summary, "normal")], inner),
            self.rule("ml", "mr", width),
            self.boxed(self.header(inner) if self.is_list() else [], inner),
        ]

        if not self.is_list():
            body = [[(" The disk tab is not available yet. Press 2 to go back.", "dim")]]
        elif not rows:
            body = [[(" Nothing to show here: every entry is empty.", "dim")]]
        else:
            cursor = self.index()
            key = self.key()
            offset = min(self.scroll.get(key, 0), cursor)
            offset = max(offset, cursor - list_height + 1)
            self.scroll[key] = offset
            grouped = any(row.header for row in rows)
            body = [self.row(row, number == cursor, inner, grouped and not row.header)
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
            info = (viewer.info or "broken link") + " "
        trail = chars["crumb"].join([self.stack[0].name] + viewer.trail)
        crumb = " " + fit(trail, max(1, inner - len(info) - 1), chars, tail=True)

        rows = viewer.wrapped(inner - 8)
        viewer.max_top = max(0, len(rows) - content_height)
        viewer.top = max(0, min(viewer.top, viewer.max_top))
        shown = rows[viewer.top: viewer.top + content_height]
        body = []
        for number, text in shown:
            gutter = ("%6d " % number) if number is not None else " " * 7
            body.append([(" " + gutter, "dim"), (text, viewer.tone if viewer.warning and number == 1 else "normal")])
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

    def render_question(self, width, height):
        inner = width - 2
        question = self.question

        def line(text, style="normal"):
            return self.boxed([(" " + fit(text, inner - 2, self.chars), style)], inner)

        lines = [
            self.rule("tl", "tr", width, "online lookup"),
            line("Send the SHA-256 of %d flagged file%s to VirusTotal?" % (
                question.count, "" if question.count == 1 else "s"), "bold"),
            line(""),
            line("  Only the 64-character hashes are sent: not the files, and not their names."),
            line("  Your VT_API_KEY is read from the environment and is never stored."),
            line("  At most %d hashes are looked up, and it stops if the service says it is busy." % question.cap),
            line("  Say no and the other checks still run."),
            line(""),
            self.boxed([(" Send the hashes?  [y/N]", "danger")], inner),
            self.key_line("", "[Esc] skip online  [q] quit", inner),
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
        match = next((child for child in node.visible() if child.name == agent and not child.header), None)
        if match is None:
            return None
        node = match
        trail.append(node.name)
    rows = [row for row in node.visible() if row.header != "gap"]
    now = time.time()
    if not rows:
        return ["Nothing found under %s." % library.home]
    grouped = any(row.header for row in rows)
    labels = [
        ("  " if grouped and not row.header else "") + (
            row.name if not row.link else "%s -> %s" % (row.name, tilde(row.link, library.home)))
        for row in rows
    ]
    name_width = min(max(len(label) for label in labels), 56)
    counted = [row for row in rows if not row.header]
    more = "+" if any(row.partial for row in counted) else ""
    lines = ["%s   total %s%s, %s%s %s%s" % (
        " > ".join(trail), format_size(sum(r.size for r in counted)), more,
        format(sum(r.paths for r in counted), ","), more, "files" if library.disk else "paths",
        " (mock data, not your files)" if library.mock else "")]
    lines.append("%s  %9s  %9s  %4s  %s" % (
        "NAME".ljust(name_width), "FILES" if library.disk else "PATHS", "SIZE", "AGE",
        "KIND" if library.disk else "TYPE"))
    for row, label in zip(rows, labels):
        if row.size <= 0:
            paths = size = age = "-"
        else:
            paths, size, age = count_text(row), size_text(row), format_age(now - row.mtime)
        lines.append("%s  %9s  %9s  %4s  %s" % (
            fit(label, name_width, ASCII_CHARS, tail=not row.link), paths, size, age, status_text(row)))
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


def run_screen(screen, home, ascii_only, scanner):
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    styles = make_styles()

    def say(text):
        draw(screen, [[(text, "normal")]], styles)

    def announce(name):
        say("Scanning %s ..." % name)

    browser = Browser(
        load(home, progress=announce), lambda: load(home), ascii_only=ascii_only,
        rules=load_rules(home, progress=announce), rules_loader=lambda: load_rules(home),
        disk_loader=scanner.scan, online_ready=scanner.can_go_online(), online_cap=scanner.online_cap,
    )
    browser.status = say
    while browser.running:
        height, width = screen.getmaxyx()
        draw(screen, browser.render(width, height), styles)
        key = read_key(screen)
        if key:
            browser.handle_key(key)


XPROTECT = "/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Resources/XProtect.yara"


def account_home():
    """The home folder of the account that runs the tool, from the user database and not from $HOME."""
    try:
        return pwd.getpwuid(os.getuid()).pw_dir
    except (KeyError, OSError):
        return os.path.expanduser("~")


def make_scanner(home, args):
    """The disk scanner for this run. Only your real home is scanned together with /tmp and the system's login items."""
    real = os.path.realpath(home) == os.path.realpath(account_home())
    listed = args.hashes or os.environ.get("MEMORY_BAD_HASHES")
    rules = args.rules or os.environ.get("MEMORY_YARA_RULES") or (XPROTECT if os.path.isfile(XPROTECT) else None)
    return DiskScanner(
        home, real=real, bad_hashes=load_hashes(listed) if listed else set(), rules=rules,
        online_key=os.environ.get("VT_API_KEY") or os.environ.get("VIRUSTOTAL_API_KEY"),
        online_url=os.environ.get("MEMORY_VT_URL") or VT_URL,
    )


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
        description="See and manage what your coding agents remember, and the rules and skills you give them. "
        "Move learned memory, rules and skills to the Trash.",
    )
    parser.add_argument("--list", action="store_true", help="print the table and exit; changes nothing")
    parser.add_argument("--agent", metavar="NAME", help="with --list: show the memory of one agent")
    parser.add_argument("--tab", choices=("memory", "rules", "disk"), default="memory", help="with --list: which tab to print")
    parser.add_argument("--home", metavar="PATH", help="scan this home folder instead of yours")
    parser.add_argument("--deep", action="store_true", help="disk tab: also run the hash list, YARA and ClamAV")
    parser.add_argument("--online", action="store_true", help="disk tab: also look flagged hashes up at VirusTotal")
    parser.add_argument("--hashes", metavar="FILE", help="a list of known-bad SHA-256 hashes, one to a line")
    parser.add_argument("--rules", metavar="FILE", help="YARA rules for the disk tab (needs the yara program)")
    args = parser.parse_args(argv)
    home = os.path.abspath(os.path.expanduser(args.home or "~"))

    try:
        scanner = make_scanner(home, args)
    except OSError as error:
        print("memory: cannot read the hash list: %s" % error, file=sys.stderr)
        return 2
    if args.online and not scanner.can_go_online():
        print("memory: --online needs VT_API_KEY in the environment; the online lookup is skipped.", file=sys.stderr)
    if args.list or args.agent:
        loaders = {
            "memory": load, "rules": load_rules,
            "disk": lambda path: scanner.scan(deep=args.deep or args.online, online=args.online),
        }
        lines = list_view(loaders[args.tab](home), args.agent)
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
    curses.wrapper(run_screen, home, ascii_only, scanner)
    return 0


if __name__ == "__main__":
    sys.exit(main())
