"""Write files without ever leaving a half-written one behind.

Every mutation of a user-owned file goes through here: temp file in the same
directory, fsync, os.replace. A crash mid-run leaves the old file intact.
"""

import datetime
import errno
import os
import shutil


def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path, exist_ok=True)
    return path


def read_text(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except IOError as exc:
        if exc.errno in (errno.ENOENT, errno.EISDIR):
            return default
        raise


def atomic_write_text(path, text):
    """Replace `path` with `text`, preserving the existing file mode.

    Writes *through* a symlink. Plenty of people keep `~/.zshrc` as a link into
    a dotfiles repo; replacing the link with a real file would quietly detach
    them from it.
    """
    if os.path.islink(path):
        path = os.path.realpath(path)
    ensure_dir(os.path.dirname(os.path.abspath(path)))
    mode = None
    try:
        mode = os.stat(path).st_mode & 0o777
    except OSError:
        pass
    tmp = "%s.hw-tmp-%d" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return path


def stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def _free_name(path, note):
    target = "%s.%s-%s" % (path, note, stamp())
    suffix = 1
    while os.path.lexists(target):
        suffix += 1
        target = "%s.%s-%s-%d" % (path, note, stamp(), suffix)
    return target


def backup_once(path, note="backup"):
    """Move `path` aside to `<path>.<note>-<stamp>`. Returns the new path.

    For things the installer is about to displace outright, like a real `~/.zsh`
    directory where the symlink has to go.
    """
    if not os.path.lexists(path):
        return None
    target = _free_name(path, note)
    shutil.move(path, target)
    return target


def backup_copy(path, note="backup"):
    """Copy `path` aside, leaving the original where it is.

    For files we edit rather than replace. Copying also keeps a `~/.zshrc` that
    is a symlink into a dotfiles repo intact.
    """
    if not os.path.isfile(path):
        return None
    target = _free_name(path, note)
    shutil.copy2(path, target)
    return target


def is_symlink_to(path, target):
    if not os.path.islink(path):
        return False
    try:
        return os.path.realpath(path) == os.path.realpath(target)
    except OSError:
        return False


def symlink(target, link_path):
    """Create/replace a symlink at `link_path` pointing at `target`."""
    ensure_dir(os.path.dirname(os.path.abspath(link_path)))
    tmp = "%s.hw-tmp-%d" % (link_path, os.getpid())
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(target, tmp)
    os.replace(tmp, link_path)
    return link_path


def remove_link(path):
    """Remove a symlink. Never recurses into a real directory."""
    if os.path.islink(path):
        os.unlink(path)
        return True
    return False
