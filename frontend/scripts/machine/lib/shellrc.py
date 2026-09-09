"""Editing `~/.zshrc` without taking it over.

We own exactly one marked block. Everything else in the file is the user's.
Two extra edits, both marked and both reversible:

*   `source ~/.zsh/<x>.zsh` lines the managed block now covers get commented
    out, so fragments are not sourced twice;
*   a `source` of a Claude scratchpad `deno/env` is dropped — those paths live
    under /private/tmp and vanish, leaving a broken login shell.
"""

import re

from .paths import MARKER, MARKER_COMMENT_PREFIX

BEGIN = "# >>> " + MARKER + " >>>"
END = "# <<< " + MARKER + " <<<"

_SUPERSEDED = MARKER_COMMENT_PREFIX + " superseded by the block below"

_FRAGMENT_RE = re.compile(
    r"^\s*(?:source|\.)\s+[\"']?(?:~|\$HOME|\$\{HOME\})/\.zsh/[A-Za-z0-9._-]+\.zsh[\"']?\s*$"
)
_SCRATCHPAD_RE = re.compile(
    r"^\s*(?:source|\.)\s+[\"']?\S*/claude-\S*/scratchpad/\S*/env[\"']?\s*$"
)


def _lines(text):
    return (text or "").splitlines()


def find_block(lines):
    """(start, end) inclusive indices of the managed block, or None."""
    start = None
    for index, line in enumerate(lines):
        if line.strip() == BEGIN:
            start = index
        elif line.strip() == END and start is not None:
            return start, index
    return None


def apply(text, body):
    """Install/refresh the managed block. Returns (new_text, notes)."""
    lines = _lines(text)
    notes = []

    kept = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if _SCRATCHPAD_RE.match(line):
            notes.append(("dropped", line.strip()))
            index += 1
            continue
        if _FRAGMENT_RE.match(line):
            if index and kept and kept[-1].strip() == _SUPERSEDED:
                kept.append(line)
                index += 1
                continue
            notes.append(("commented", line.strip()))
            kept.append(_SUPERSEDED)
            kept.append("# " + line.lstrip())
            index += 1
            continue
        kept.append(line)
        index += 1

    block = [BEGIN] + _lines(body) + [END]
    span = find_block(kept)
    if span:
        start, end = span
        if kept[start:end + 1] != block:
            notes.append(("refreshed", "managed block"))
        kept[start:end + 1] = block
    else:
        notes.append(("added", "managed block"))
        while kept and not kept[-1].strip():
            kept.pop()
        if kept:
            kept.append("")
        kept.extend(block)

    return "\n".join(kept) + "\n", notes


def strip(text):
    """Remove the managed block and un-comment what it superseded."""
    lines = _lines(text)
    notes = []
    span = find_block(lines)
    if span:
        start, end = span
        del lines[start:end + 1]
        while start < len(lines) and not lines[start].strip():
            del lines[start]
        while start and not lines[start - 1].strip() and (
            start >= len(lines) or not lines[start].strip()
        ):
            del lines[start - 1]
            start -= 1
        notes.append(("removed", "managed block"))

    restored = []
    index = 0
    while index < len(lines):
        if lines[index].strip() == _SUPERSEDED and index + 1 < len(lines):
            following = lines[index + 1]
            uncommented = re.sub(r"^(\s*)#\s?", r"\1", following)
            restored.append(uncommented.strip())
            lines[index + 1] = uncommented
            del lines[index]
            continue
        index += 1
    for line in restored:
        notes.append(("restored", line))

    text = "\n".join(lines)
    return (text + "\n") if text.strip() else "", notes


def would_change(text, body):
    new_text, _notes = apply(text, body)
    return new_text != (text or "")
