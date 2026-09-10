"""Character-at-a-time terminal input.

cbreak rather than raw: newline translation and signal handling stay with the
terminal, so ctrl-C still unwinds normally. The mode is restored on every path
out of the context manager, including an exception.

A terminal that cannot do this — no termios, `TERM` unset or `dumb`, stdin not
a terminal — raises `Unsupported` so the caller can fall back to typed lines.
"""

import os
import select
import sys

try:
    import termios
    import tty
except ImportError:          # not a posix terminal; the typed fallback works
    termios = tty = None


class Unsupported(Exception):
    pass


_ARROWS = {b"A": "up", b"B": "down", b"C": "right", b"D": "left"}

# How long to wait for the rest of an escape sequence before deciding the ESC
# was a lone keypress. Long enough for a local terminal, short enough that the
# key does not feel stuck.
_ESCAPE_GRACE = 0.06


def available():
    """Can this terminal be put into cbreak mode?"""
    if termios is None:
        return False
    if os.environ.get("TERM", "") in ("", "dumb"):
        return False
    if not sys.stdin.isatty():
        return False
    try:
        termios.tcgetattr(sys.stdin.fileno())
    except (OSError, ValueError, termios.error):
        return False
    return True


def read_key(fd):
    """One keypress, named.

    Arrow keys arrive as `ESC [ A`, so a lone ESC has to be told apart from
    the start of one by waiting a moment for the rest to show up.
    """
    char = os.read(fd, 1)
    if not char:
        return "eof"
    if char == b"\x1b":
        ready, _, _ = select.select([fd], [], [], _ESCAPE_GRACE)
        if not ready:
            return "escape"
        if os.read(fd, 1) != b"[":
            return "other"
        return _ARROWS.get(os.read(fd, 1), "other")
    if char in (b"\r", b"\n"):
        return "enter"
    if char == b" ":
        return "space"
    if char in (b"\x03", b"\x04"):
        return "abort"
    return char.decode("utf-8", "replace").lower()


def drain(fd, limit=64):
    """Throw away whatever is already sitting in the buffer.

    A single-key prompt has to eat the newline behind a typed `y`, or the next
    prompt reads it as "just pressed enter". Type-ahead into a confirmation is
    exactly the input you do not want to honour anyway.
    """
    for _ in range(limit):
        ready, _, _ = select.select([fd], [], [], 0)
        if not ready:
            return
        if not os.read(fd, 1):
            return


class cbreak(object):
    """`with cbreak() as keyboard: keyboard.key()`."""

    def __init__(self):
        self.fd = None
        self._saved = None

    def __enter__(self):
        if not available():
            raise Unsupported()
        self.fd = sys.stdin.fileno()
        try:
            self._saved = termios.tcgetattr(self.fd)
            # TCSANOW, not tty.setcbreak's default TCSAFLUSH: flushing would
            # throw away anything typed in the moment between the prompt being
            # printed and the mode changing, and that key is the answer.
            tty.setcbreak(self.fd, termios.TCSANOW)
        except (OSError, ValueError, termios.error):
            raise Unsupported()
        return self

    def __exit__(self, *_exc):
        if self._saved is not None:
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self._saved)
        return False

    def key(self):
        return read_key(self.fd)
