"""A small, careful TOML layer.

Two jobs, deliberately kept apart:

*   `loads` parses a document so we can compare what is already configured.
    It is a subset parser, but a strict one: anything it does not understand
    raises `TomlError` and the caller skips that file rather than guessing.
*   `upsert_table` / `remove_table` edit a document by *line span*. The rest of
    the file is copied through byte for byte, so a user's comments, ordering
    and inline-table formatting survive untouched. We never round-trip a
    user-owned config through the parser and back out.

Written for python 3.8+, so `tomllib` (3.11+) is not available; the system
python on macOS is 3.9.
"""

import bisect
import re
import string

from .paths import MARKER_COMMENT_PREFIX


class TomlError(Exception):
    pass


_BARE = set(string.ascii_letters + string.digits + "_-")
_WS = " \t"

_DATETIME_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?"
    r"|\d{2}:\d{2}:\d{2}(\.\d+)?"
)
_NUMBER_RE = re.compile(
    r"[+-]?("
    r"0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|"
    r"(inf|nan)|"
    r"[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9_]+)?"
    r")"
)
_ESCAPES = {
    "b": "\b", "t": "\t", "n": "\n", "f": "\f", "r": "\r",
    '"': '"', "\\": "\\", "e": "\x1b",
}


class Table(object):
    """Where a `[header]` block sits in the source text.

    `start` is the header line, or the first line of a contiguous comment block
    directly above it when that comment is one of ours. `content_end` is one
    past the line holding the block's last key/value — trailing comments and
    blank lines are outside it, because a comment above the next header belongs
    to that header. `end` is where the next block's span begins.
    """

    __slots__ = ("path", "is_array", "start", "header_line", "content_end",
                 "end", "value_end")

    def __init__(self, path, is_array, start, header_line):
        self.path = path
        self.is_array = is_array
        self.start = start
        self.header_line = header_line
        self.content_end = header_line + 1
        self.end = header_line + 1
        self.value_end = 0

    def __repr__(self):
        return "<Table %s lines %d..%d>" % (".".join(self.path), self.start, self.end)


class Document(object):
    def __init__(self, text, data, tables):
        self.text = text
        self.data = data
        self.tables = tables

    def find(self, path):
        """First standard table at `path`, or None."""
        path = tuple(path)
        for table in self.tables:
            if table.path == path and not table.is_array:
                return table
        return None

    def get(self, path, default=None):
        node = self.data
        for part in path:
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------

class _Parser(object):
    def __init__(self, text):
        self.t = text
        self.n = len(text)
        self.i = 0
        self.line_starts = [0]
        for index, char in enumerate(text):
            if char == "\n":
                self.line_starts.append(index + 1)
        self.nlines = len(text.splitlines())
        if text.startswith("﻿"):
            # Step over a BOM rather than stripping it: the offsets here are
            # used to edit the file in place, and the BOM stays the file's.
            self.i = 1

    # -- helpers ----------------------------------------------------------
    def line_of(self, index):
        return bisect.bisect_right(self.line_starts, index) - 1

    def fail(self, message):
        raise TomlError("%s (line %d)" % (message, self.line_of(self.i) + 1))

    def eof(self):
        return self.i >= self.n

    def peek(self, offset=0):
        index = self.i + offset
        return self.t[index] if index < self.n else ""

    def starts(self, literal):
        return self.t.startswith(literal, self.i)

    def skip_ws(self):
        while self.i < self.n and self.t[self.i] in _WS:
            self.i += 1

    def skip_comment(self):
        if self.peek() == "#":
            while self.i < self.n and self.t[self.i] != "\n":
                self.i += 1

    def skip_blank(self):
        """Whitespace, comments and newlines between statements."""
        while self.i < self.n:
            char = self.t[self.i]
            if char in _WS or char in "\r\n":
                self.i += 1
            elif char == "#":
                self.skip_comment()
            else:
                break

    def expect_line_end(self):
        self.skip_ws()
        self.skip_comment()
        if self.eof():
            return
        if self.t[self.i] in "\r\n":
            self.i += 1
            return
        self.fail("expected end of line, found %r" % self.t[self.i])

    # -- keys -------------------------------------------------------------
    def parse_key(self):
        parts = []
        while True:
            self.skip_ws()
            char = self.peek()
            if char == '"':
                parts.append(self.parse_basic_string())
            elif char == "'":
                parts.append(self.parse_literal_string())
            elif char in _BARE:
                start = self.i
                while self.i < self.n and self.t[self.i] in _BARE:
                    self.i += 1
                parts.append(self.t[start:self.i])
            else:
                self.fail("expected a key, found %r" % char)
            self.skip_ws()
            if self.peek() == ".":
                self.i += 1
                continue
            return parts

    # -- strings ----------------------------------------------------------
    def parse_basic_string(self):
        if self.starts('"""'):
            return self.parse_multiline_basic()
        self.i += 1  # opening quote
        out = []
        while True:
            if self.eof():
                self.fail("unterminated string")
            char = self.t[self.i]
            if char == '"':
                self.i += 1
                return "".join(out)
            if char == "\n":
                self.fail("newline in single-line string")
            if char == "\\":
                self.i += 1
                out.append(self.parse_escape())
                continue
            out.append(char)
            self.i += 1

    def parse_escape(self):
        char = self.peek()
        if char in _ESCAPES:
            self.i += 1
            return _ESCAPES[char]
        if char in "uU":
            width = 4 if char == "u" else 8
            self.i += 1
            digits = self.t[self.i:self.i + width]
            if len(digits) < width:
                self.fail("truncated unicode escape")
            self.i += width
            try:
                return chr(int(digits, 16))
            except ValueError:
                self.fail("bad unicode escape")
        self.fail("unknown escape \\%s" % char)

    def parse_multiline_basic(self):
        self.i += 3
        if self.peek() == "\n":
            self.i += 1
        elif self.starts("\r\n"):
            self.i += 2
        out = []
        while True:
            if self.eof():
                self.fail("unterminated multiline string")
            if self.starts('"""'):
                # Up to two extra quotes belong to the content.
                extra = 0
                while self.peek(3 + extra) == '"' and extra < 2:
                    extra += 1
                out.append('"' * extra)
                self.i += 3 + extra
                return "".join(out)
            char = self.t[self.i]
            if char == "\\":
                nxt = self.peek(1)
                if nxt in "\r\n" or (nxt in _WS and self._only_ws_to_eol(self.i + 1)):
                    self.i += 1
                    while self.i < self.n and self.t[self.i] in _WS + "\r\n":
                        self.i += 1
                    continue
                self.i += 1
                out.append(self.parse_escape())
                continue
            out.append(char)
            self.i += 1

    def _only_ws_to_eol(self, index):
        while index < self.n and self.t[index] in _WS:
            index += 1
        return index < self.n and self.t[index] in "\r\n"

    def parse_literal_string(self):
        if self.starts("'''"):
            self.i += 3
            if self.peek() == "\n":
                self.i += 1
            elif self.starts("\r\n"):
                self.i += 2
            end = self.t.find("'''", self.i)
            if end < 0:
                self.fail("unterminated multiline literal string")
            value = self.t[self.i:end]
            self.i = end + 3
            return value
        self.i += 1
        end = self.t.find("'", self.i)
        newline = self.t.find("\n", self.i)
        if end < 0 or (0 <= newline < end):
            self.fail("unterminated literal string")
        value = self.t[self.i:end]
        self.i = end + 1
        return value

    # -- values -----------------------------------------------------------
    def parse_value(self):
        char = self.peek()
        if char == '"':
            return self.parse_basic_string()
        if char == "'":
            return self.parse_literal_string()
        if char == "[":
            return self.parse_array()
        if char == "{":
            return self.parse_inline_table()
        if self.starts("true"):
            self.i += 4
            return True
        if self.starts("false"):
            self.i += 5
            return False
        match = _DATETIME_RE.match(self.t, self.i)
        if match:
            self.i = match.end()
            return match.group(0)
        match = _NUMBER_RE.match(self.t, self.i)
        if match:
            raw = match.group(0)
            self.i = match.end()
            return _number(raw)
        self.fail("unrecognised value")

    def parse_array(self):
        self.i += 1  # [
        items = []
        while True:
            self.skip_blank()
            if self.eof():
                self.fail("unterminated array")
            if self.peek() == "]":
                self.i += 1
                return items
            items.append(self.parse_value())
            self.skip_blank()
            if self.peek() == ",":
                self.i += 1
                continue
            self.skip_blank()
            if self.peek() == "]":
                self.i += 1
                return items
            self.fail("expected ',' or ']' in array")

    def parse_inline_table(self):
        self.i += 1  # {
        out = {}
        while True:
            # TOML 1.0 forbids newlines here; 1.1 allows them. Accept both.
            self.skip_blank()
            if self.eof():
                self.fail("unterminated inline table")
            if self.peek() == "}":
                self.i += 1
                return out
            key = self.parse_key()
            self.skip_ws()
            if self.peek() != "=":
                self.fail("expected '=' in inline table")
            self.i += 1
            self.skip_ws()
            _assign(out, key, self.parse_value(), self)
            self.skip_blank()
            if self.peek() == ",":
                self.i += 1
                continue
            self.skip_blank()
            if self.peek() == "}":
                self.i += 1
                return out
            self.fail("expected ',' or '}' in inline table")

    # -- document ---------------------------------------------------------
    def parse(self):
        root = {}
        current = root
        current_table = None
        tables = []

        while True:
            self.skip_blank()
            if self.eof():
                break
            if self.peek() == "[":
                is_array = self.starts("[[")
                header_line = self.line_of(self.i)
                self.i += 2 if is_array else 1
                path = tuple(self.parse_key())
                self.skip_ws()
                closer = "]]" if is_array else "]"
                if not self.starts(closer):
                    self.fail("unterminated table header")
                self.i += len(closer)
                self.expect_line_end()
                current = _open_table(root, path, is_array, self)
                current_table = Table(
                    path, is_array, self._marker_start(header_line), header_line
                )
                current_table.value_end = self.i
                tables.append(current_table)
                continue
            key = self.parse_key()
            self.skip_ws()
            if self.peek() != "=":
                self.fail("expected '=' after key")
            self.i += 1
            self.skip_ws()
            value = self.parse_value()
            _assign(current, key, value, self)
            self.expect_line_end()
            if current_table is not None:
                current_table.value_end = self.i

        self._close_spans(tables)
        return Document(self.t, root, tables)

    def _close_spans(self, tables):
        """A block runs until the next block's span begins.

        Done in a second pass because the next block's span may reach back
        above its own header to swallow one of our marker comments.
        """
        for index, table in enumerate(tables):
            table.end = tables[index + 1].start if index + 1 < len(tables) else self.nlines
            table.end = max(table.end, table.header_line + 1)
            # The last *value* ends the block. Anything after it — blank lines,
            # a comment introducing the next header — is not ours to move.
            last = max(table.value_end - 1, 0)
            content_end = self.line_of(last) + 1
            table.content_end = min(max(content_end, table.header_line + 1), table.end)

    def _marker_start(self, header_line):
        """Pull a contiguous comment block above the header into the span, but
        only when it is one of ours. A user's comment stays put."""
        line = header_line - 1
        start = header_line
        while line >= 0:
            text = self._line_text(line).strip()
            if not text.startswith("#"):
                break
            if not text.startswith(MARKER_COMMENT_PREFIX):
                break
            start = line
            line -= 1
        return start

    def _line_text(self, index):
        if index < 0 or index >= len(self.line_starts):
            return ""
        start = self.line_starts[index]
        end = self.line_starts[index + 1] if index + 1 < len(self.line_starts) else self.n
        return self.t[start:end]


def _number(raw):
    cleaned = raw.replace("_", "")
    lowered = cleaned.lower()
    try:
        if lowered.startswith(("0x", "-0x", "+0x")):
            return int(cleaned, 16)
        if lowered.startswith(("0o", "-0o", "+0o")):
            return int(cleaned, 8)
        if lowered.startswith(("0b", "-0b", "+0b")):
            return int(cleaned, 2)
        if "." in cleaned or "e" in lowered or "inf" in lowered or "nan" in lowered:
            return float(cleaned)
        return int(cleaned)
    except ValueError:
        return cleaned


def _assign(node, key_parts, value, parser):
    for part in key_parts[:-1]:
        node = node.setdefault(part, {})
        if not isinstance(node, dict):
            parser.fail("cannot extend non-table key %r" % part)
    node[key_parts[-1]] = value


def _open_table(root, path, is_array, parser):
    node = root
    for part in path[:-1]:
        nxt = node.get(part)
        if isinstance(nxt, list):
            nxt = nxt[-1] if nxt else None
        if nxt is None:
            nxt = {}
            node[part] = nxt
        if not isinstance(nxt, dict):
            parser.fail("cannot nest under non-table key %r" % part)
        node = nxt
    last = path[-1]
    if is_array:
        bucket = node.setdefault(last, [])
        if not isinstance(bucket, list):
            parser.fail("cannot append to non-array key %r" % last)
        entry = {}
        bucket.append(entry)
        return entry
    nxt = node.get(last)
    if not isinstance(nxt, dict):
        nxt = {}
        node[last] = nxt
    return nxt


def loads(text):
    """Parse a document. Raises TomlError on anything unrecognised."""
    return _Parser(text).parse()


def load_data(text):
    return loads(text).data


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

_BARE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def quote_key(key):
    if _BARE_KEY_RE.match(key):
        return key
    return dump_string(key)


def dump_string(value):
    out = ['"']
    for char in value:
        if char == '"':
            out.append('\\"')
        elif char == "\\":
            out.append("\\\\")
        elif char == "\n":
            out.append("\\n")
        elif char == "\t":
            out.append("\\t")
        elif char == "\r":
            out.append("\\r")
        elif ord(char) < 0x20:
            out.append("\\u%04X" % ord(char))
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def dump_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return dump_string(value)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(dump_value(item) for item in value) + "]"
    if isinstance(value, dict):
        inner = ", ".join(
            "%s = %s" % (quote_key(k), dump_value(v)) for k, v in value.items()
        )
        return "{ " + inner + " }" if inner else "{}"
    raise TomlError("cannot serialise %r" % type(value))


def header(path, is_array=False):
    joined = ".".join(quote_key(part) for part in path)
    return "[[%s]]" % joined if is_array else "[%s]" % joined


def render_table(path, mapping, marker=None):
    """A `[path]` block. Scalars first, then nested dicts as sub-tables."""
    lines = []
    if marker:
        lines.append(MARKER_COMMENT_PREFIX + " " + marker)
    lines.append(header(path))
    nested = []
    for key, value in mapping.items():
        if isinstance(value, dict):
            nested.append((key, value))
            continue
        lines.append("%s = %s" % (quote_key(key), dump_value(value)))
    for key, value in nested:
        lines.append("")
        lines.append(render_table(tuple(path) + (key,), value))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# surgical editing
# --------------------------------------------------------------------------

def _split(text):
    return text.splitlines(True)


def _join(lines):
    return "".join(lines)


def table_text(text, path):
    """The exact source of the `[path]` block, or None. Used for fingerprints."""
    table = loads(text).find(path)
    if table is None:
        return None
    lines = _split(text)
    return _join(lines[table.start:table.content_end])


def upsert_table(text, path, mapping, marker=None):
    """Insert or replace `[path]`. Everything else is copied through."""
    block = render_table(path, mapping, marker=marker)
    document = loads(text)
    table = document.find(path)
    lines = _split(text)
    block_lines = [line + "\n" for line in block.split("\n")]
    if table is None:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] = lines[-1] + "\n"
        while lines and not lines[-1].strip():
            lines.pop()
        if lines:
            lines.append("\n")
        return _join(lines + block_lines)
    return _join(lines[:table.start] + block_lines + lines[table.content_end:])


def remove_table(text, path):
    """Delete `[path]` and the blank lines it owned. No-op when absent."""
    document = loads(text)
    table = document.find(path)
    if table is None:
        return text
    lines = _split(text)
    # Swallow the blank lines our block owned, but stop at the first non-blank:
    # a comment sitting above the next header belongs to that header, not to us.
    end = table.content_end
    for line in range(table.content_end, table.end):
        if lines[line].strip():
            break
        end = line + 1
    remaining = lines[:table.start] + lines[end:]
    if table.start == 0:
        while remaining and not remaining[0].strip():
            remaining.pop(0)
    if end >= len(lines):
        # We took the tail of the file with us; do not leave a blank line behind.
        while remaining and not remaining[-1].strip():
            remaining.pop()
    if remaining and not remaining[-1].endswith("\n"):
        remaining[-1] = remaining[-1] + "\n"
    return _join(remaining)
