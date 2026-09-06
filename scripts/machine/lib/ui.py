"""Terminal output. Plain text, one line per fact, no spinners."""

import os
import sys

from . import keys

_STYLES = {
    "add": "\033[32m",
    "update": "\033[33m",
    "remove": "\033[31m",
    "keep": "\033[2m",
    "skip": "\033[2m",
    "warn": "\033[33m",
    "error": "\033[31m",
    "head": "\033[1m",
    "dim": "\033[2m",
}
_RESET = "\033[0m"


def colors_on(stream=None):
    stream = stream or sys.stdout
    if os.environ.get("NO_COLOR") or os.environ.get("HUB_WILLIAM_NO_COLOR"):
        return False
    if os.environ.get("TERM", "") == "dumb":
        return False
    return hasattr(stream, "isatty") and stream.isatty()


def style(text, name, stream=None):
    if not colors_on(stream) or name not in _STYLES:
        return text
    return _STYLES[name] + text + _RESET


def say(text=""):
    sys.stdout.write(text + "\n")


def head(text):
    say(style(text, "head"))


def warn(text):
    sys.stderr.write(style("warning: ", "warn") + text + "\n")


def error(text):
    sys.stderr.write(style("error: ", "error") + text + "\n")


def bullet(verb, text, reason=""):
    tag = style("%-7s" % verb, verb)
    line = "  %s %s" % (tag, text)
    if reason:
        line += style("  (%s)" % reason, "dim")
    say(line)


def ask(question, default=True):
    """y/n on stdin, one keypress. Non-interactive stdin takes the default."""
    if not sys.stdin.isatty():
        return default
    prompt = "%s %s " % (question, "[Y/n]" if default else "[y/N]")
    try:
        answer = _ask_key(prompt, default)
    except keys.Unsupported:
        return _ask_line(prompt, default)
    # Echo it: cbreak does not, and a transcript with a bare prompt and no
    # answer in it is unreadable afterwards.
    say("y" if answer else "n")
    return answer


def _ask_key(prompt, default):
    with keys.cbreak() as keyboard:
        while True:
            sys.stdout.write(prompt)
            sys.stdout.flush()
            key = keyboard.key()
            if key == "abort":
                raise KeyboardInterrupt
            if key in ("enter", "eof"):
                keys.drain(keyboard.fd)
                return default
            if key in ("y", "n"):
                keys.drain(keyboard.fd)
                return key == "y"
            sys.stdout.write("\n")


def _ask_line(prompt, default):
    while True:
        try:
            answer = input(prompt).strip().lower()
        except EOFError:
            return default
        if not answer:
            return default
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False


def ask_text(question, default=""):
    if not sys.stdin.isatty():
        return default
    try:
        answer = input("%s " % question).strip()
    except EOFError:
        return default
    return answer or default
