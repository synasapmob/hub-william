"""JSON read/merge/write that keeps the file's own shape.

`~/.claude.json` is the CLI's live state file. We only ever touch one key in
it, and we write it back with the same indent it arrived with.
"""

import json
import os
import re

from . import atomic

_INDENT_RE = re.compile(r"^\{\s*\n(\s+)\S", re.MULTILINE)


def read(path):
    """(data, indent). Missing or empty file reads as ({}, 2)."""
    text = atomic.read_text(path)
    if text is None or not text.strip():
        return {}, 2
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise ValueError("%s is not valid JSON: %s" % (path, exc))
    if not isinstance(data, dict):
        raise ValueError("%s is not a JSON object" % path)
    match = _INDENT_RE.search(text)
    indent = len(match.group(1)) if match else 2
    return data, indent


def write(path, data, indent=2):
    text = json.dumps(data, indent=indent, ensure_ascii=False)
    if not text.endswith("\n"):
        text += "\n"
    return atomic.atomic_write_text(path, text)


def fingerprint(value):
    """Stable hash of a JSON value, for installer-ownership checks."""
    import hashlib
    blob = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(blob.encode("utf-8")).hexdigest()


def exists(path):
    return os.path.exists(path)
