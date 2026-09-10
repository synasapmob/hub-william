"""The Hub William wordmark.

"HUB WILLIAM" drawn in block characters, with the command and the repo below
it. Printed once at the top of init, sync and mcp auth. Never animated.

41 columns wide. Anything narrower than that falls back to plain text rather
than wrapping into noise.
"""

import os
import shutil
import sys

from . import paths

WORDMARK = (
    "█ █ █ █ ██    █   █ █ █   █   █  █  █   █",
    "█ █ █ █ █ █   █   █ █ █   █   █ █ █ ██ ██",
    "███ █ █ ██    █ █ █ █ █   █   █ ███ █ █ █",
    "█ █ █ █ █ █   ██ ██ █ █   █   █ █ █ █   █",
    "█ █ ███ ██    █   █ █ ███ ███ █ █ █ █   █",
)

WIDTH = max(len(line) for line in WORDMARK)

_ORANGE = "\033[38;5;209m"
_DIM = "\033[2m"
_RESET = "\033[0m"

_printed = set()


def _colors_on(stream):
    if os.environ.get("NO_COLOR") or os.environ.get("HUB_WILLIAM_NO_COLOR"):
        return False
    if os.environ.get("TERM", "") == "dumb":
        return False
    return hasattr(stream, "isatty") and stream.isatty()


def _columns():
    """Terminal width, or 80.

    A terminal that never had its window size set reports 0 rather than
    failing, and shutil passes that straight through — so check the number,
    not just for an exception.
    """
    try:
        columns = shutil.get_terminal_size((80, 24)).columns
    except (OSError, ValueError):
        return 80
    return columns if columns > 0 else 80


def render(subtitle, color=True, columns=None):
    """The banner as a string. `subtitle` is the command, e.g. "sync"."""
    columns = columns or _columns()
    meta = "machine %s · %s" % (subtitle, paths.tilde(paths.repo_root()))

    if columns < WIDTH:
        mark = "HUB WILLIAM"
        if color:
            mark = _ORANGE + mark + _RESET
            meta = _DIM + meta + _RESET
        return mark + "\n" + meta

    lines = list(WORDMARK)
    if color:
        lines = [_ORANGE + line + _RESET for line in lines]
        meta = _DIM + meta + _RESET
    return "\n".join(lines) + "\n\n" + meta


def show(subtitle, stream=None, once=True):
    """Print the banner. Repeated calls in one process are ignored."""
    if once and subtitle in _printed:
        return
    _printed.add(subtitle)
    stream = stream or sys.stdout
    stream.write(render(subtitle, color=_colors_on(stream)) + "\n\n")
    stream.flush()
