"""What this installer created, so it can remove exactly that and no more.

State is the primary ownership record. Generated artifacts also carry their
own marker, and catalog symlinks prove themselves by target, so a lost state
file does not strand them. A foreign symlink, an edited config block, and a
real `secrets.zsh` remain someone else's and are left alone.
"""

import os

from . import atomic, jsonfile, paths, ui

VERSION = 2


class State(object):
    def __init__(self, data=None, path=None):
        self.path = path or paths.applied_file()
        data = data or {}
        self.data = {
            "version": VERSION,
            "links": data.get("links") or {},
            "generated": data.get("generated") or {},
            "mcp": data.get("mcp") or {},
            "files": data.get("files") or {},
            "backups": data.get("backups") or [],
            "zshrc": data.get("zshrc") or {},
            "plugins": data.get("plugins") or {},
        }

    @classmethod
    def load(cls, path=None):
        path = path or paths.applied_file()
        try:
            data, _ = jsonfile.read(path)
        except ValueError as exc:
            # Losing this file is not fatal, but it does mean the installer no
            # longer knows what is his. Say so rather than quietly forgetting.
            ui.warn(
                "%s is unreadable (%s). Nothing already installed will be "
                "removed by this run; it now looks user-owned." % (paths.tilde(path), exc)
            )
            backup = atomic.backup_once(path, "unreadable")
            if backup:
                ui.warn("kept the old one at " + paths.tilde(backup))
            data = {}
        return cls(data, path)

    def save(self):
        atomic.ensure_dir(os.path.dirname(self.path))
        jsonfile.write(self.path, self.data, indent=2)
        return self.path

    # -- symlinks ---------------------------------------------------------
    def record_link(self, link_path, kind, name, agent=None, target=None):
        self.data["links"][os.path.abspath(link_path)] = {
            "kind": kind,
            "name": name,
            "agent": agent,
            "target": target,
        }

    def link_record(self, link_path):
        return self.data["links"].get(os.path.abspath(link_path))

    def forget_link(self, link_path):
        self.data["links"].pop(os.path.abspath(link_path), None)

    def links(self, kind=None, agent=None, name=None):
        for path, meta in sorted(self.data["links"].items()):
            if kind and meta.get("kind") != kind:
                continue
            if agent and meta.get("agent") != agent:
                continue
            if name and meta.get("name") != name:
                continue
            yield path, meta

    # -- generated files and trees --------------------------------------
    def record_generated(self, path, kind, name, agent=None, source=None,
                         fingerprint=None):
        self.data["generated"][os.path.abspath(path)] = {
            "kind": kind,
            "name": name,
            "agent": agent,
            "source": source,
            "fingerprint": fingerprint,
        }

    def generated_record(self, path):
        return self.data["generated"].get(os.path.abspath(path))

    def forget_generated(self, path):
        self.data["generated"].pop(os.path.abspath(path), None)

    def generated(self, kind=None, agent=None, name=None):
        for path, meta in sorted(self.data["generated"].items()):
            if kind and meta.get("kind") != kind:
                continue
            if agent and meta.get("agent") != agent:
                continue
            if name and meta.get("name") != name:
                continue
            yield path, meta

    # -- mcp blocks -------------------------------------------------------
    @staticmethod
    def mcp_key(agent, name):
        return "%s/%s" % (agent, name)

    def record_mcp(self, agent, name, fingerprint):
        self.data["mcp"][self.mcp_key(agent, name)] = {
            "agent": agent,
            "name": name,
            "fingerprint": fingerprint,
        }

    def mcp_record(self, agent, name):
        return self.data["mcp"].get(self.mcp_key(agent, name))

    def forget_mcp(self, agent, name):
        self.data["mcp"].pop(self.mcp_key(agent, name), None)

    def mcps(self, agent=None):
        for key, meta in sorted(self.data["mcp"].items()):
            if agent and meta.get("agent") != agent:
                continue
            yield key, meta

    # -- plain files we copied in ----------------------------------------
    def record_file(self, path, kind, note=""):
        self.data["files"][os.path.abspath(path)] = {"kind": kind, "note": note}

    def file_record(self, path):
        return self.data["files"].get(os.path.abspath(path))

    def forget_file(self, path):
        self.data["files"].pop(os.path.abspath(path), None)

    # -- backups and the managed ~/.zshrc block ---------------------------
    def record_backup(self, original, backup, note=""):
        self.data["backups"].append(
            {"original": os.path.abspath(original), "backup": backup, "note": note}
        )

    def set_zshrc(self, **fields):
        self.data["zshrc"].update(fields)

    def zshrc(self):
        return self.data["zshrc"]

    def record_plugin(self, agent, name):
        self.data["plugins"]["%s/%s" % (agent, name)] = {"agent": agent, "name": name}

    def plugin_record(self, agent, name):
        return self.data["plugins"].get("%s/%s" % (agent, name))

    def forget_plugin(self, agent, name):
        self.data["plugins"].pop("%s/%s" % (agent, name), None)
