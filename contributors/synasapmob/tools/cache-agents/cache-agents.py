#!/usr/bin/env python3
# cache-agents: see what your coding agents keep on disk, and clear their cache
#
# A terminal browser for the folders that Claude Code, Codex and Gemini fill in your home
# directory. It lists each agent with its size, the number of paths inside and when it last
# changed, lets you open a folder to look inside, and moves cache to the Trash. It never
# deletes a file for good, and it never touches transcripts, memory, settings, skills or
# anything else that is not a cache. Nothing leaves your computer.
#
# Run it from Hub William (it reads and writes only under your home folder, and needs a
# terminal on macOS or Linux with Python 3.9 or newer):
#   curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/cache-agents/cache-agents.py | python3
# Or run a downloaded copy: python3 cache-agents.py
# Print the table without the interface, changing nothing: python3 cache-agents.py --list
#
# Keys: arrows or h j k l move, Right or Enter opens a folder, Left goes back, D deletes the
# cache under the cursor (or all of it on the first screen) after a preview and a
# confirmation, r scans again, q quits.

import argparse
import locale
import os
import shutil
import stat
import sys
import time
from collections import namedtuple
from urllib.parse import quote

try:
    import curses
except ImportError:  # Windows ships no curses
    curses = None

CACHE = "cache"
KEEP = "keep"
MIXED = "mixed"

MIN_WIDTH = 64
MIN_HEIGHT = 12
STALE_SECONDS = 30 * 86400

# Where each agent keeps its files, under the home folder. "projects" names the folder that
# holds one subfolder per project; "cache" lists the top-level entries that are safe to
# clear. Everything not listed there is data and is never offered for deletion. The lists
# come from the folder names, not from the agents' documentation, so add to them with care.
AgentSpec = namedtuple("AgentSpec", "name folder projects cache")
AGENTS = (
    AgentSpec(
        "claude",
        ".claude",
        "projects",
        ("cache", "shell-snapshots", "paste-cache", "telemetry", "session-env"),
    ),
    AgentSpec("codex", ".codex", None, ("cache",)),
    AgentSpec("gemini", ".gemini", None, ()),
)

UNICODE_CHARS = {
    "h": "─", "v": "│", "tl": "┌", "tr": "┐", "bl": "└",
    "br": "┘", "ml": "├", "mr": "┤", "crumb": " › ", "dot": " · ",
    "ellipsis": "…", "updown": "↑↓", "right": "→", "left": "←",
}
ASCII_CHARS = {
    "h": "-", "v": "|", "tl": "+", "tr": "+", "bl": "+", "br": "+", "ml": "+", "mr": "+",
    "crumb": " > ", "dot": " | ", "ellipsis": "...", "updown": "Up/Down", "right": "Right",
    "left": "Left",
}


# --- Measuring -------------------------------------------------------------------------


class Entry(object):
    """A file, a folder, or a group of them (path is None) with what is inside it added up."""

    __slots__ = ("name", "path", "is_dir", "kind", "agent", "size", "paths", "mtime", "children")

    def __init__(self, name, path=None, is_dir=True, kind=KEEP, agent=None):
        self.name = name
        self.path = path
        self.is_dir = is_dir
        self.kind = kind
        self.agent = agent
        self.size = 0
        self.paths = 0
        self.mtime = 0.0
        self.children = []

    def add(self, child):
        self.children.append(child)
        self.size += child.size
        self.paths += child.paths
        self.mtime = max(self.mtime, child.mtime)

    def sort(self):
        self.children.sort(key=lambda child: (-child.size, child.name))

    def visible(self):
        """What the screens list: an entry with no size is never shown."""
        return [child for child in self.children if child.size > 0]


def disk_usage(info, seen):
    """Bytes on disk, with a file hard-linked several times counted once."""
    if info.st_nlink > 1 and not stat.S_ISDIR(info.st_mode):
        key = (info.st_dev, info.st_ino)
        if key in seen:
            return 0
        seen.add(key)
    blocks = getattr(info, "st_blocks", None)
    return blocks * 512 if blocks is not None else info.st_size


def scan(path, kind, agent, seen):
    """Measure a path and everything under it. Symlinks count as one path and are not followed."""
    try:
        info = os.lstat(path)
    except OSError:
        return None
    entry = Entry(os.path.basename(path), path, stat.S_ISDIR(info.st_mode), kind, agent)
    entry.size = disk_usage(info, seen)
    entry.mtime = info.st_mtime
    if entry.is_dir:
        try:
            names = os.listdir(path)
        except OSError:
            names = []
        for name in names:
            child = scan(os.path.join(path, name), kind, agent, seen)
            if child is not None:
                entry.add(child)
        entry.sort()
    if entry.size > 0:
        entry.paths += 1  # an entry without a size is never listed, so it is not counted
    return entry


def tilde(path, home):
    for prefix in (home, os.path.realpath(home)):
        if path == prefix:
            return "~"
        if path.startswith(prefix + os.sep):
            return "~" + path[len(prefix):]
    return path


def decode_project(folder, home):
    """Turn Claude's project folder name back into the path it stands for.

    Claude writes "/" and "." both as "-", so "hub-william" could be "hub/william". The
    only way to tell is to look for the path that exists; if none does, keep the raw name.
    """
    if not folder.startswith("-"):
        return folder
    tokens = folder[1:].split("-")

    def walk(current, index):
        if index == len(tokens):
            return current
        for end in range(index + 1, len(tokens) + 1):
            part = tokens[index:end]
            if part[0] == "":
                if len(part) == 1:
                    continue
                segment = "." + "-".join(part[1:])
            else:
                segment = "-".join(part)
            candidate = os.path.join(current, segment)
            if end == len(tokens):
                if os.path.lexists(candidate):
                    return candidate
            elif os.path.isdir(candidate):
                found = walk(candidate, end)
                if found:
                    return found
        return None

    found = walk(os.sep, 0)
    return tilde(found, home) if found else folder


def load_agent(spec, home, seen):
    """One agent as a group: Global, then each project, or just its entries when it has none."""
    root = os.path.realpath(os.path.join(home, spec.folder))
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return None
    agent = Entry(spec.name, None, True, KEEP, spec.name)
    shared = Entry("Global", None, True, KEEP, spec.name)
    projects = []
    for name in names:
        path = os.path.join(root, name)
        if spec.projects and name == spec.projects and os.path.isdir(path):
            try:
                folders = sorted(os.listdir(path))
            except OSError:
                folders = []
            for folder in folders:
                project = scan(os.path.join(path, folder), KEEP, spec.name, seen)
                if project is not None:
                    project.name = decode_project(folder, home)
                    projects.append(project)
            continue
        child = scan(path, CACHE if name in spec.cache else KEEP, spec.name, seen)
        if child is not None:
            shared.add(child)
    shared.sort()
    if projects:
        agent.add(shared)
        projects.sort(key=lambda project: (-project.size, project.name))
        for project in projects:
            agent.add(project)
    else:
        for child in shared.children:
            agent.add(child)
    return agent, root


class Library(object):
    """Every agent found under one home folder, as scanned at one moment."""

    def __init__(self, home, root, roots, scanned_at):
        self.home = home
        self.root = root
        self.roots = roots
        self.scanned_at = scanned_at


def load(home, now=None, progress=None, specs=AGENTS):
    seen = set()
    root = Entry("cache-agents")
    roots = {}
    for spec in specs:
        if progress is not None:
            progress(spec.name)
        found = load_agent(spec, home, seen)
        if found is None:
            continue
        agent, real_root = found
        roots[spec.name] = real_root
        if agent.size > 0:
            root.add(agent)
    root.sort()
    return Library(home, root, roots, time.time() if now is None else now)


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


# --- Cache and deleting ----------------------------------------------------------------


def prunable(entry):
    """The parts of an entry that may be deleted: cache, and nothing that is data."""
    if entry.kind == CACHE:
        return [entry]
    if entry.path is None:
        return [item for child in entry.children for item in prunable(child)]
    return []


def entry_status(entry):
    removable = sum(item.size for item in prunable(entry))
    if removable <= 0:
        return KEEP
    return CACHE if removable >= entry.size else MIXED


class Plan(object):
    def __init__(self, title, items, kept):
        self.title = title
        self.items = items
        self.kept = kept
        self.size = sum(item.size for item in items)
        self.paths = sum(item.paths for item in items)


AGENT_BY_NAME = dict((spec.name, spec) for spec in AGENTS)


def refusal(entry, library):
    """Why an entry must not be deleted, or None. Checked again just before every move."""
    spec = AGENT_BY_NAME.get(entry.agent)
    root = library.roots.get(entry.agent)
    if entry.kind != CACHE or entry.path is None or spec is None or root is None:
        return "not a cache"
    if not entry.path.startswith(root + os.sep):
        return "outside the agent folder"
    if entry.path[len(root) + 1:].split(os.sep)[0] not in spec.cache:
        return "not a cache"
    if not os.path.lexists(entry.path):
        return "already gone"
    if os.path.realpath(entry.path) != entry.path:
        return "reached through a symlink"
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


def run_plan(plan, library, now=None):
    """Move every item to the Trash. Returns the entries moved and (entry, reason) failures."""
    moved = []
    failed = []
    for entry in plan.items:
        reason = refusal(entry, library)
        if reason is None:
            try:
                move_to_trash(entry.path, library.home, entry.agent, now)
            except (OSError, shutil.Error) as error:
                reason = str(error)
        if reason is None:
            moved.append(entry)
        else:
            failed.append((entry, reason))
    return moved, failed


# --- The screen ------------------------------------------------------------------------


class Dialog(object):
    """The preview shown before anything is deleted. phrase is None for a y/N question."""

    def __init__(self, plan, phrase):
        self.plan = plan
        self.phrase = phrase
        self.typed = ""
        self.note = ""


class Browser(object):
    """What is on screen and what each key does, with no curses in it."""

    def __init__(self, library, loader=None, clock=time.time, ascii_only=False):
        self.library = library
        self.loader = loader
        self.clock = clock
        self.chars = ASCII_CHARS if ascii_only else UNICODE_CHARS
        self.stack = [library.root]
        self.cursors = [0]
        self.offsets = [0]
        self.tab = 1
        self.message = ""
        self.dialog = None
        self.running = True
        self.page = 5

    # State

    @property
    def node(self):
        return self.stack[-1]

    def rows(self):
        return self.node.visible()

    def current(self):
        rows = self.rows()
        if not rows:
            return None
        return rows[min(self.cursors[-1], len(rows) - 1)]

    def move(self, delta):
        count = len(self.rows())
        if count:
            self.cursors[-1] = max(0, min(count - 1, self.cursors[-1] + delta))

    def open(self):
        entry = self.current()
        if entry is None or not entry.is_dir or not entry.visible():
            self.message = "Nothing to open: this is a file or an empty folder."
            return
        self.stack.append(entry)
        self.cursors.append(0)
        self.offsets.append(0)

    def back(self):
        if len(self.stack) > 1:
            self.stack.pop()
            self.cursors.pop()
            self.offsets.pop()

    def reload(self):
        """Scan again and return to the same place, or the nearest one that still exists."""
        if self.loader is None:
            return
        names = [entry.name for entry in self.stack[1:]]
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
        self.cursors = (self.cursors + [0] * len(stack))[: len(stack)]
        self.offsets = (self.offsets + [0] * len(stack))[: len(stack)]
        self.move(0)

    # Deleting

    def begin_delete(self):
        everything = len(self.stack) == 1
        scope = self.node if everything else self.current()
        if scope is None:
            self.message = "Nothing is selected."
            return
        items = [item for item in prunable(scope) if item.size > 0]
        if not items:
            self.message = "Nothing to delete: %s holds data, not cache." % (
                "everything here" if everything else '"%s"' % scope.name
            )
            return
        title = "Delete ALL agent cache" if everything else 'Delete cache of "%s"' % scope.name
        plan = Plan(title, items, scope.size - sum(item.size for item in items))
        phrase = "DELETE " + format_size(plan.size).replace(" ", "") if everything else None
        self.dialog = Dialog(plan, phrase)

    def confirm_delete(self):
        plan = self.dialog.plan
        self.dialog = None
        moved, failed = run_plan(plan, self.library, self.clock())
        size = sum(entry.size for entry in moved)
        text = "Moved %s to the Trash (%d item%s)." % (
            format_size(size), len(moved), "" if len(moved) == 1 else "s",
        )
        if failed:
            text += " Could not move %d: %s: %s." % (len(failed), failed[0][0].name, failed[0][1])
        self.reload()
        self.message = text

    def dialog_key(self, key):
        dialog = self.dialog
        if key == "resize":
            return
        if key == "esc":
            self.dialog = None
            self.message = "Cancelled. Nothing was deleted."
        elif dialog.phrase is None:
            if key in ("y", "Y"):
                self.confirm_delete()
            else:
                self.dialog = None
                self.message = "Cancelled. Nothing was deleted."
        elif key == "enter":
            if dialog.typed == dialog.phrase:
                self.confirm_delete()
            else:
                dialog.note = "That does not match. Type it exactly, or press Esc."
        elif key == "backspace":
            dialog.typed = dialog.typed[:-1]
            dialog.note = ""
        elif len(key) == 1 and len(dialog.typed) < 40:
            dialog.typed += key
            dialog.note = ""

    # Keys

    def handle_key(self, key):
        if self.dialog is not None:
            self.dialog_key(key)
            return
        self.message = ""
        if key == "q":
            self.running = False
        elif key == "1":
            self.tab = 0
        elif key in ("2", "tab"):
            self.tab = 1 if key == "2" or self.tab == 0 else 0
        elif self.tab == 0:
            return
        elif key in ("up", "k"):
            self.move(-1)
        elif key in ("down", "j"):
            self.move(1)
        elif key == "pageup":
            self.move(-self.page)
        elif key == "pagedown":
            self.move(self.page)
        elif key in ("home", "g"):
            self.move(-len(self.rows()))
        elif key in ("end", "G"):
            self.move(len(self.rows()))
        elif key in ("right", "enter", "l"):
            self.open()
        elif key in ("left", "backspace", "h"):
            self.back()
        elif key == "r":
            self.reload()
            self.message = "Scanned again."
        elif key == "D":
            self.begin_delete()
        elif key == "d":
            self.message = "Press D (Shift+d) to delete."

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
        return inner - 39

    def cells(self, entry, name_width):
        now = self.clock()
        return (
            fit(entry.name, name_width, self.chars, tail=True),
            format(entry.paths, ",").rjust(9),
            format_size(entry.size).rjust(9),
            format_age(now - entry.mtime).rjust(4),
            entry_status(entry).ljust(5),
        )

    def row(self, entry, selected, inner):
        name, paths, size, age, status = self.cells(entry, self.columns(inner))
        marker = "> " if selected else "  "
        gap = "  "
        if selected:
            return [(" " + marker + name + gap + paths + gap + size + gap + age + gap + status + " ", "cursor")]
        stale = self.clock() - entry.mtime > STALE_SECONDS
        tone = {CACHE: "ok", MIXED: "warn", KEEP: "dim"}[status.strip()]
        return [
            (" " + marker + name + gap + paths + gap + size + gap, "normal"),
            (age, "warn" if stale else "normal"),
            (gap, "normal"),
            (status, tone),
            (" ", "normal"),
        ]

    def header(self, inner):
        gap = "  "
        text = (
            "   " + "NAME".ljust(self.columns(inner)) + gap + "PATHS".rjust(9) + gap
            + "SIZE".rjust(9) + gap + "AGE".rjust(4) + gap + "KIND".ljust(5) + " "
        )
        return [(text, "head")]

    def keys(self):
        chars = self.chars
        if self.tab == 0:
            return "[2] cache-agents  [q] quit"
        move = "[%s] move  [%s] open" % (chars["updown"], chars["right"])
        back = "  [%s] back" % chars["left"] if len(self.stack) > 1 else ""
        if len(self.stack) == 1:
            removable = sum(item.size for item in prunable(self.node))
            action = (
                "[D] delete all cache (%s)" % format_size(removable)
                if removable
                else "[D] nothing to delete"
            )
        else:
            entry = self.current()
            removable = sum(item.size for item in prunable(entry)) if entry else 0
            action = (
                '[D] delete cache of "%s" (%s)' % (entry.name, format_size(removable))
                if removable
                else "[D] nothing to delete here"
            )
        return "%s%s  %s  [r] rescan  [q] quit" % (move, back, action)

    def scanned_text(self):
        age = self.clock() - self.library.scanned_at
        return "scanned just now" if age < 60 else "scanned %s ago" % format_age(age)

    def render(self, width, height):
        if width < MIN_WIDTH or height < MIN_HEIGHT:
            return [[("Terminal too small: need %dx%d, have %dx%d." % (
                MIN_WIDTH, MIN_HEIGHT, width, height), "danger")]]
        if self.dialog is not None:
            return self.render_dialog(width, height)
        inner = width - 2
        chars = self.chars
        rows = self.rows() if self.tab == 1 else []
        list_height = height - 10
        self.page = max(1, list_height - 1)

        tabs = [(" ", "normal")]
        tabs.append(("[1 disk]" if self.tab == 0 else "1 disk", "tab" if self.tab == 0 else "dim"))
        tabs.append(("  ", "normal"))
        tabs.append(("[2 cache-agents]" if self.tab == 1 else "2 cache-agents",
                     "tab" if self.tab == 1 else "dim"))
        used = sum(len(text) for text, _ in tabs)
        right = self.scanned_text() + " "
        tabs.append((" " * max(1, inner - used - len(right)), "normal"))
        tabs.append((right, "dim"))

        total_size = sum(row.size for row in rows)
        total_paths = sum(row.paths for row in rows)
        trail = chars["crumb"].join(entry.name for entry in self.stack)
        summary = ""
        if self.tab == 1 and rows:
            summary = "total %s%s%s paths " % (format_size(total_size), chars["dot"], format(total_paths, ","))
        crumb_width = max(1, inner - len(summary) - 1)
        crumb = " " + fit(trail if self.tab == 1 else "disk", crumb_width, chars, tail=True)

        lines = [
            self.rule("tl", "tr", width, "hub-william"),
            self.boxed(tabs, inner),
            self.rule("ml", "mr", width),
            self.boxed([(crumb, "bold"), (summary, "normal")], inner),
            self.rule("ml", "mr", width),
            self.boxed(self.header(inner) if self.tab == 1 else [], inner),
        ]

        if self.tab == 0:
            body = [[(" The disk tab is not available yet. Press 2 to go back.", "dim")]]
        elif not rows:
            empty = (
                "No agent folders with data found in %s." % self.library.home
                if len(self.stack) == 1
                else "Nothing to show here: every entry is empty."
            )
            body = [[(" " + empty, "dim")]]
        else:
            cursor = min(self.cursors[-1], len(rows) - 1)
            offset = self.offsets[-1]
            offset = min(offset, cursor)
            offset = max(offset, cursor - list_height + 1)
            self.offsets[-1] = offset
            body = [self.row(row, index == cursor, inner)
                    for index, row in enumerate(rows) if offset <= index < offset + list_height]
        for number in range(list_height):
            lines.append(self.boxed(body[number] if number < len(body) else [], inner))

        status = [(" " + self.message, "danger" if "Could not" in self.message else "normal")]
        lines += [
            self.rule("ml", "mr", width),
            self.boxed(status, inner),
            self.boxed([(" " + fit(self.keys(), inner - 2, chars), "dim")], inner),
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

        lines = [self.rule("tl", "tr", width, "delete " + chars["dot"].strip() + " preview"),
                 line(plan.title, "bold"), line("")]
        lines.append(line("  %s  %9s  (%d item%s, %s paths)" % (
            "will move to the Trash".ljust(22), format_size(plan.size), len(plan.items),
            "" if len(plan.items) == 1 else "s", format(plan.paths, ","))))
        lines.append(line("  %s  %9s" % ("kept, not cache".ljust(22), format_size(plan.kept))))
        lines.append(line(""))
        room = max(1, height - 14)
        for item in plan.items[:room]:
            size = format_size(item.size).rjust(9)
            label = "%s  %s" % (item.agent, tilde(item.path, home))
            lines.append(line("  " + fit(label, inner - 2 - 2 - 10, chars, tail=True) + " " + size))
        if len(plan.items) > room:
            lines.append(line("  ... and %d more" % (len(plan.items) - room), "dim"))
        lines += [line(""), line("Quit any agent that is running first: it may still use these folders.", "dim")]
        if dialog.phrase is None:
            lines.append(line("Move to the Trash?  [y/N]", "danger"))
        else:
            lines.append(line("Type  %s  to confirm:  %s_" % (dialog.phrase, dialog.typed), "danger"))
            if dialog.note:
                lines.append(line(dialog.note, "danger"))
        lines += [line("[Esc] cancel", "dim"), self.rule("bl", "br", width)]
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
    name_width = min(max(len(row.name) for row in rows), 48)
    lines = ["%s   total %s, %s paths" % (
        " > ".join(trail), format_size(sum(r.size for r in rows)),
        format(sum(r.paths for r in rows), ","))]
    lines.append("%s  %9s  %9s  %4s  %s" % ("NAME".ljust(name_width), "PATHS", "SIZE", "AGE", "KIND"))
    for row in rows:
        lines.append("%s  %9s  %9s  %4s  %s" % (
            fit(row.name, name_width, ASCII_CHARS, tail=True), format(row.paths, ","),
            format_size(row.size), format_age(now - row.mtime), entry_status(row)))
    return lines


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
    return None


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
            room = width - x - (1 if y == height - 1 else 0)
            if room > 0:
                try:
                    screen.addstr(y, x, text[:room], styles.get(style, 0))
                except curses.error:
                    pass
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

    browser = Browser(load(home, progress=announce), lambda: load(home), ascii_only=ascii_only)
    while browser.running:
        height, width = screen.getmaxyx()
        draw(screen, browser.render(width, height), styles)
        key = translate(screen.getch())
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
        prog="cache-agents",
        description="See what your coding agents keep on disk, and move their cache to the Trash.",
    )
    parser.add_argument("--list", action="store_true", help="print the table and exit; changes nothing")
    parser.add_argument("--agent", metavar="NAME", help="with --list: show the folders of one agent")
    parser.add_argument("--home", metavar="PATH", help="scan this home folder instead of yours")
    args = parser.parse_args(argv)
    home = os.path.abspath(os.path.expanduser(args.home or "~"))

    if args.list or args.agent:
        lines = list_view(load(home), args.agent)
        if lines is None:
            print("cache-agents: no agent named %r with data under %s" % (args.agent, home), file=sys.stderr)
            return 2
        print("\n".join(lines))
        return 0

    if curses is None or not attach_terminal():
        print("cache-agents needs a terminal on macOS or Linux. Use --list to print the table.", file=sys.stderr)
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
