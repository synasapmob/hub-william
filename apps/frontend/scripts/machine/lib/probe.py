"""Which CLIs exist on this machine.

The installer never installs an agent CLI (non-goal #1). It only reports what
is there, because a missing CLI changes the default agent set.
"""

import os
import shutil

from . import paths

# Vendors that put their binary outside PATH until a shell fragment adds it.
_FALLBACK_BINS = {
    "grok": (".grok", "bin", "grok"),
}


def which(name):
    """Absolute path to `name`, or None. Falls back to known vendor dirs."""
    found = shutil.which(name)
    if found:
        return os.path.abspath(found)
    parts = _FALLBACK_BINS.get(name)
    if parts:
        candidate = os.path.join(paths.home(), *parts)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def probe(names):
    """{name: path or None} for each CLI."""
    return dict((name, which(name)) for name in names)
