"""One installer at a time.

`sync` reconciles home against the catalog and rewrites state/applied.json.
Two of those racing would lose records, so every mutating command takes this
lock first.
"""

import errno
import os
import time

from . import atomic, paths


class LockBusy(Exception):
    pass


class Lock(object):
    def __init__(self, path=None, stale_after=900):
        self.path = path or paths.lock_file()
        self.stale_after = stale_after
        self.held = False

    def _stale(self):
        try:
            age = time.time() - os.path.getmtime(self.path)
        except OSError:
            return False
        if age < self.stale_after:
            try:
                with open(self.path, "r", encoding="utf-8") as handle:
                    pid = int((handle.read().split() or ["0"])[0])
            except (IOError, ValueError):
                return False
            if pid <= 0:
                return True
            try:
                os.kill(pid, 0)
            except OSError as exc:
                return exc.errno == errno.ESRCH
            return False
        return True

    def acquire(self):
        atomic.ensure_dir(os.path.dirname(self.path))
        for attempt in range(2):
            try:
                handle = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except OSError as exc:
                if exc.errno != errno.EEXIST:
                    raise
                if attempt == 0 and self._stale():
                    try:
                        os.unlink(self.path)
                    except OSError:
                        pass
                    continue
                raise LockBusy(
                    "another machine install is running (%s). Remove it if not."
                    % paths.tilde(self.path)
                )
            os.write(handle, ("%d %d\n" % (os.getpid(), int(time.time()))).encode())
            os.close(handle)
            self.held = True
            return self
        raise LockBusy("could not take %s" % paths.tilde(self.path))

    def release(self):
        if self.held:
            try:
                os.unlink(self.path)
            except OSError:
                pass
            self.held = False

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_exc):
        self.release()
        return False
