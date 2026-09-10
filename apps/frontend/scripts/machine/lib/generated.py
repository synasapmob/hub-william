"""Generated, read-only artifacts installed from the catalog.

The catalog is the editable source of truth. Agent homes receive copies so an
editor opened at ``~/.codex/AGENTS.md`` cannot accidentally mutate the catalog
through a symlink. Every sync repairs content or permissions that drifted.
"""

import hashlib
import json
import os
import shutil

from . import atomic


MARKER = "hub-william-generated"
TREE_MARKER = ".hub-william-generated.json"


def markdown(source, source_label):
    body = atomic.read_text(source)
    if body is None:
        raise IOError("generated source is missing: %s" % source)
    header = "<!-- %s: DO NOT EDIT; source=%s -->\n\n" % (MARKER, source_label)
    return header + body


def is_markdown(path):
    if os.path.islink(path) or not os.path.isfile(path):
        return False
    first = atomic.read_text(path, default="") or ""
    return first.startswith("<!-- %s:" % MARKER)


def markdown_matches(path, desired):
    if not is_markdown(path):
        return False
    return atomic.read_text(path) == desired and not (os.stat(path).st_mode & 0o222)


def write_markdown(path, desired):
    """Atomically replace a path itself, never the destination of a symlink."""
    atomic.ensure_dir(os.path.dirname(os.path.abspath(path)))
    tmp = "%s.hw-generated-%d" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(desired)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o444)
        os.replace(tmp, path)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


def _tree_digest(root, skip_marker=False):
    digest = hashlib.sha256()
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        relative_dir = os.path.relpath(current, root)
        for name in files:
            if skip_marker and relative_dir == "." and name == TREE_MARKER:
                continue
            path = os.path.join(current, name)
            relative = os.path.relpath(path, root).replace(os.sep, "/")
            digest.update(relative.encode("utf-8"))
            digest.update(b"\0")
            if os.path.islink(path):
                digest.update(b"link\0")
                digest.update(os.readlink(path).encode("utf-8"))
            else:
                digest.update(b"file\0")
                digest.update(b"x" if os.stat(path).st_mode & 0o111 else b"-")
                with open(path, "rb") as handle:
                    for chunk in iter(lambda: handle.read(65536), b""):
                        digest.update(chunk)
            digest.update(b"\0")
    return digest.hexdigest()


def source_fingerprint(source):
    return _tree_digest(source)


def _marker(path):
    marker = os.path.join(path, TREE_MARKER)
    try:
        with open(marker, encoding="utf-8") as handle:
            data = json.load(handle)
    except (IOError, OSError, ValueError):
        return None
    return data if data.get("marker") == MARKER else None


def is_tree(path, kind=None, name=None, agent=None):
    if os.path.islink(path) or not os.path.isdir(path):
        return False
    data = _marker(path)
    if not data:
        return False
    for key, expected in (("kind", kind), ("name", name), ("agent", agent)):
        if expected is not None and data.get(key) != expected:
            return False
    return True


def tree_matches(path, source, kind, name, agent):
    if not is_tree(path, kind, name, agent):
        return False
    if _tree_digest(path, skip_marker=True) != source_fingerprint(source):
        return False
    for current, _dirs, files in os.walk(path, followlinks=False):
        for filename in files:
            installed = os.path.join(current, filename)
            if not os.path.islink(installed) and os.stat(installed).st_mode & 0o222:
                return False
    return True


def _make_tree(source, temp, metadata):
    shutil.copytree(source, temp, symlinks=True)
    marker = dict(metadata)
    marker["marker"] = MARKER
    marker["source_fingerprint"] = source_fingerprint(source)
    marker_path = os.path.join(temp, TREE_MARKER)
    with open(marker_path, "w", encoding="utf-8") as handle:
        json.dump(marker, handle, indent=2, sort_keys=True)
        handle.write("\n")
    for current, _dirs, files in os.walk(temp, followlinks=False):
        for filename in files:
            path = os.path.join(current, filename)
            if os.path.islink(path):
                continue
            mode = os.stat(path).st_mode & 0o777
            mode = (mode & ~0o222) or 0o444
            os.chmod(path, mode)


def write_tree(source, target, metadata):
    """Build beside the destination and swap, restoring the old tree on error."""
    atomic.ensure_dir(os.path.dirname(os.path.abspath(target)))
    temp = "%s.hw-generated-%d" % (target, os.getpid())
    old = "%s.hw-old-%d" % (target, os.getpid())
    for leftover in (temp, old):
        if os.path.lexists(leftover):
            if os.path.isdir(leftover) and not os.path.islink(leftover):
                shutil.rmtree(leftover)
            else:
                os.unlink(leftover)
    moved = False
    try:
        _make_tree(source, temp, metadata)
        if os.path.lexists(target):
            os.replace(target, old)
            moved = True
        os.replace(temp, target)
        if moved:
            if os.path.isdir(old) and not os.path.islink(old):
                shutil.rmtree(old)
            else:
                os.unlink(old)
    except Exception:
        if moved and not os.path.lexists(target) and os.path.lexists(old):
            os.replace(old, target)
        raise
    finally:
        for leftover in (temp, old):
            if os.path.lexists(leftover):
                if os.path.isdir(leftover) and not os.path.islink(leftover):
                    shutil.rmtree(leftover)
                else:
                    os.unlink(leftover)


def remove_tree(path):
    if os.path.islink(path):
        os.unlink(path)
        return
    if os.path.isdir(path):
        shutil.rmtree(path)
