"""The `init` screen: arrow keys and one space bar.

    tools ─┬─ frontend-mcps ── playwright ── claude / codex / grok
           └─ alias ────────── terminal.zsh

How deep a branch goes depends on what is on it. An MCP server or a skill is
chosen agent by agent, so there is a level under it; a shell fragment is one
switch for the machine, so there is not. Right stops where there is nothing
more to say, and the hint stops offering it.

Left and right walk that tree; left does nothing at the top, so the edges are
dead ends rather than surprises.

Space is the same verb at every level — turn this on, turn this off. Higher up
it just covers more rows: on a group it means every item in it, for every
agent. A box reading `~` is the honest answer to "is this on?" when some
agents have it and some do not.

Enter is `sync`. Nothing here writes to disk; the caller does that after.
"""

import os
import sys

from . import banner, keys, paths, probe, ui
from .agents import AGENT_NAMES

QUIT = "quit"
SYNC = "sync"

_HINTS = {
    0: "↑↓ move · space toggle · → open · enter sync · q quit",
    1: "↑↓ move · space toggle · ← back · → agents · enter sync · q quit",
    2: "↑↓ move · space toggle · ← back · enter sync · q quit",
}
_NO_DEEPER = "↑↓ move · space toggle · ← back · enter sync · q quit"


class Row(object):
    __slots__ = ("label", "note", "leaves", "mark", "openable")

    def __init__(self, label, note="", leaves=(), mark=" ", openable=False):
        self.label = label
        self.note = note
        self.leaves = list(leaves)
        self.mark = mark
        self.openable = openable


class Browser(object):
    """Reads and writes `profile` in place. `run()` returns SYNC or QUIT."""

    def __init__(self, profile, agents, groups, columns=None, prefill_all=False):
        self.profile = profile
        self.agents = list(agents)
        self.groups = list(groups)
        self.columns = columns
        self.level = 0
        self.cursor = [0, 0, 0]
        if prefill_all:
            # First run: there is no earlier answer to respect, and an empty
            # screen is a worse place to start from than a full one.
            for group in self.groups:
                self._toggle_to(self._group_leaves(group), True)

    # -- what the cursor is pointing at ------------------------------------
    @property
    def group(self):
        if not self.groups:
            return None
        return self.groups[min(self.cursor[0], len(self.groups) - 1)]

    @property
    def member(self):
        members = self.group.members if self.group else []
        if not members:
            return None
        return members[min(self.cursor[1], len(members) - 1)]

    def rows(self):
        if self.level == 0:
            return [self._group_row(group) for group in self.groups]
        if self.level == 1:
            return [self._member_row(m) for m in (self.group.members if self.group else [])]
        return self._agent_rows(self.member)

    # -- leaves: the (kind, name, agent) triples a row stands for -----------
    def _member_leaves(self, member):
        if member is None or not member.present:
            return []
        if member.per_agent:
            return [(member.kind, member.name, agent.name) for agent in self.agents]
        return [(member.kind, member.name, None)]

    def _group_leaves(self, group):
        out = []
        for member in group.members:
            out.extend(self._member_leaves(member))
        return out

    def _mark(self, leaves):
        if not leaves:
            return "-"
        on = sum(1 for leaf in leaves if self.profile.leaf_on(*leaf))
        if on == 0:
            return " "
        return "x" if on == len(leaves) else "~"

    def _toggle_to(self, leaves, on):
        for kind, name, agent in leaves:
            self.profile.set_leaf(kind, name, agent, on)

    def _toggle(self, leaves):
        """Anything short of all-on turns the row on; only all-on turns it off.
        So one press out of a `~` always means "give me the rest of these"."""
        if not leaves:
            return
        self._toggle_to(leaves, not all(self.profile.leaf_on(*l) for l in leaves))

    # -- rows ---------------------------------------------------------------
    def _group_row(self, group):
        # Always openable, empty included: a group you listed but have not
        # filled in yet should say so when you look, not refuse to open.
        leaves = self._group_leaves(group)
        return Row(group.name, group.description, leaves, self._mark(leaves),
                   openable=True)

    def _member_row(self, member):
        # How deep a row goes depends on what it is. An MCP server or a skill
        # is chosen agent by agent, so there is a level under it. A shell
        # fragment is not — → would open a page with one row on it.
        leaves = self._member_leaves(member)
        if member.per_agent:
            note = member.description
        else:
            note = paths.tilde(os.path.join(paths.home_zsh(), member.name)) \
                + "  ·  machine-wide"
        return Row(member.name, note, leaves, self._mark(leaves),
                   openable=member.per_agent and bool(leaves))

    def _agent_rows(self, member):
        if member is None or not member.present or not member.per_agent:
            return []
        rows = []
        for agent in self.agents:
            leaves = [(member.kind, member.name, agent.name)]
            rows.append(Row(agent.name, _agent_note(agent, member), leaves,
                            self._mark(leaves)))
        return rows

    # -- movement -----------------------------------------------------------
    def _clamp(self):
        count = len(self.rows())
        self.cursor[self.level] = 0 if count <= 0 else \
            max(0, min(self.cursor[self.level], count - 1))

    def move(self, delta):
        count = len(self.rows())
        if count:
            self.cursor[self.level] = (self.cursor[self.level] + delta) % count

    def descend(self):
        rows = self.rows()
        if self.level >= 2 or not rows:
            return
        if not rows[self.cursor[self.level]].openable:
            return
        self.level += 1
        self.cursor[self.level] = 0
        self._clamp()

    def ascend(self):
        if self.level:
            self.level -= 1
            self._clamp()

    def toggle_here(self):
        rows = self.rows()
        if rows:
            self._toggle(rows[self.cursor[self.level]].leaves)

    def set_all(self, on):
        for row in self.rows():
            self._toggle_to(row.leaves, on)

    def commit(self):
        """Write a decision for every box that was on the screen.

        A box you left unticked is a refusal, not a shrug. That is what makes
        a later `skill add B` with no `--agent` skip the agent you unticked it
        for, instead of quietly putting it back.
        """
        for group in self.groups:
            for kind, name, agent in self._group_leaves(group):
                self.profile.set_leaf(
                    kind, name, agent, self.profile.leaf_on(kind, name, agent)
                )

    # -- drawing ------------------------------------------------------------
    def _width(self):
        columns = self.columns or banner._columns()
        return max(40, columns - 1)

    def _crumbs(self):
        parts = ["tools"]
        if self.level >= 1 and self.group:
            parts.append(self.group.name)
        if self.level >= 2 and self.member:
            parts.append(self.member.name)
        return " › ".join(parts)

    def _subtitle(self):
        if self.level == 1 and self.group:
            return self.group.description
        if self.level == 2 and self.member:
            return self.member.description
        return ""

    def _hint(self):
        if self.level == 1:
            rows = self.rows()
            here = rows[self.cursor[1]] if rows else None
            if here is None or not here.openable:
                return _NO_DEEPER
        return _HINTS[self.level]

    def frame(self):
        width = self._width()
        lines = []
        if self.level == 0:
            lines.extend(cli_block())
            lines.append("")
            lines.append(ui.style("  tools", "head"))
        else:
            lines.append(ui.style("  " + self._crumbs(), "head"))
            subtitle = self._subtitle()
            if subtitle:
                lines.append(ui.style("    " + subtitle[:width - 4], "dim"))
            lines.append("")

        rows = self.rows()
        if not rows:
            lines.append(ui.style(
                "    nothing here yet — list something in catalog/groups.toml",
                "dim"))
        for index, row in enumerate(rows):
            lines.append(self._row_line(row, index == self.cursor[self.level], width))

        lines.append("")
        lines.append(ui.style("    " + self._hint(), "dim"))
        return lines

    def _row_line(self, row, here, width):
        plain = "  %s [%s] %s" % ("›" if here else " ", row.mark, row.label)
        text = ui.style(plain, "head") if here else plain
        if row.note:
            column = max(len(plain) + 2, 24)
            room = width - column
            if room > 8:
                text += " " * (column - len(plain)) + ui.style(row.note[:room], "dim")
        return text

    # -- the loop -----------------------------------------------------------
    def run(self):
        out = sys.stdout
        drawn = 0
        with keys.cbreak() as keyboard:
            while True:
                lines = self.frame()
                if drawn:
                    out.write("\033[%dA" % drawn)
                # Frames change height between levels, so clear downward
                # rather than trusting every old line to be overwritten.
                out.write("\033[J")
                out.write("\n".join(lines) + "\n")
                out.flush()
                drawn = len(lines)

                key = keyboard.key()
                if key in ("up", "k"):
                    self.move(-1)
                elif key in ("down", "j"):
                    self.move(1)
                elif key in ("right", "l"):
                    self.descend()
                elif key in ("left", "h"):
                    self.ascend()
                elif key == "escape":
                    if not self.level:
                        return QUIT
                    self.ascend()
                elif key == "space":
                    self.toggle_here()
                elif key == "a":
                    self.set_all(True)
                elif key == "n":
                    self.set_all(False)
                elif key == "enter":
                    return SYNC
                elif key in ("q", "eof"):
                    return QUIT
                elif key == "abort":
                    raise KeyboardInterrupt


def _agent_note(agent, member):
    """Where this lands for this agent — more use than repeating the blurb."""
    try:
        if member.kind == "skills":
            return paths.tilde(os.path.join(agent.skills_dir(), member.name))
        if member.kind == "mcp":
            return paths.tilde(agent.mcp_config_path())
        if member.kind == "harness":
            return paths.tilde(agent.harness_path())
    except Exception:       # a note is never worth failing the screen over
        pass
    return ""


def cli_block():
    lines = [ui.style("  cli", "head")]
    for name in list(AGENT_NAMES) + ["gh"]:
        found = probe.which(name)
        if found:
            note = paths.tilde(found)
        else:
            note = "not installed yet"
            if name == "gh":
                note += "  (brew install gh)"
            note = ui.style(note, "dim")
        lines.append("    %-8s %s" % (name, note))
    return lines


def browse_plain(browser):
    """Same decisions, typed, for a terminal that cannot do single keypresses.

    Whole groups only — per-agent control is what the flags are for, e.g.
    `./install.sh mcp add playwright --agent codex`.
    """
    while True:
        ui.say("")
        ui.head("  tools")
        for index, group in enumerate(browser.groups, 1):
            row = browser._group_row(group)
            ui.say("    %2d) [%s] %-16s %s"
                   % (index, row.mark, group.name, ui.style(row.note[:44], "dim")))
        answer = ui.ask_text(
            "    numbers to toggle, a=all, n=none, s=sync, q=quit:"
        ).strip().lower()
        if answer in ("q", "quit"):
            return QUIT
        if answer in ("", "s", "sync"):
            return SYNC
        if answer == "a":
            for group in browser.groups:
                browser._toggle_to(browser._group_leaves(group), True)
            continue
        if answer == "n":
            for group in browser.groups:
                browser._toggle_to(browser._group_leaves(group), False)
            continue
        bad = []
        for token in answer.replace(",", " ").split():
            try:
                number = int(token)
            except ValueError:
                bad.append(token)
                continue
            if not 1 <= number <= len(browser.groups):
                bad.append(token)
                continue
            browser._toggle(browser._group_leaves(browser.groups[number - 1]))
        if bad:
            ui.warn("not a number on this screen: %s" % ", ".join(bad))
