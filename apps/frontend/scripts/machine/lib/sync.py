"""The delta.

`sync` compares three things and moves only what has to move:

    catalog   what the package has
    profile   what each agent allows / denies
    disk      what is installed in home

Rules that never bend:

*   a deny is never overridden, not by `sync`, not by a global add;
*   nothing is deleted unless state or an embedded marker proves ownership;
*   a config block the user edited is left alone and reported, not rewritten.

`plan()` is pure: it reads, decides, and mutates nothing. `apply()` runs the
closures the plan built. That split is what makes the `init` preview honest.
"""

import os
import shutil

from . import atomic, catalog, generated, paths, shellrc, ui
from .agents import AGENT_NAMES, get as get_agent
from .agents.base import AgentConfigError

VERBS = ("add", "update", "remove", "keep", "skip")
_ACTIONABLE = ("add", "update", "remove")


class Options(object):
    def __init__(self, force_mcp=False, plugins=True, shared=True, adopt=False):
        self.force_mcp = force_mcp
        self.plugins = plugins
        self.shared = shared
        self.adopt = adopt


class Change(object):
    def __init__(self, verb, kind, name, agent=None, detail="", reason="", run=None):
        self.verb = verb
        self.kind = kind
        self.name = name
        self.agent = agent
        self.detail = detail
        self.reason = reason
        self.run = run
        self.error = None

    @property
    def actionable(self):
        return self.verb in _ACTIONABLE

    def __repr__(self):
        return "<Change %s %s %s/%s>" % (self.verb, self.kind, self.agent, self.name)


def show(changes, verbose=False):
    """A preview is for deciding, so it lists what would move. `keep` means
    nothing moves, and twenty of those bury the two lines that matter."""
    shown = changes if verbose else [c for c in changes if c.verb != "keep"]
    if not shown:
        ui.say("  nothing to do")
        return
    for change in shown:
        tag = ui.style("%-7s" % change.verb, change.verb)
        rest = "%-7s %-8s %s" % (change.agent or "shared", change.kind, change.name)
        line = "  " + tag + " " + rest
        if change.detail:
            line += "  " + ui.style(change.detail, "dim")
        if change.reason:
            line += "  " + ui.style("(" + change.reason + ")", "dim")
        ui.say(line)


class Reconciler(object):
    def __init__(self, profile, state, agents, options=None, missing=()):
        self.profile = profile
        self.state = state
        self.agents = list(agents)
        self.options = options or Options()
        self.missing = list(missing)

    # -- planning ---------------------------------------------------------
    def plan(self):
        changes = []
        changes.extend(self._plan_skills())
        changes.extend(self._plan_mcp())
        changes.extend(self._plan_harness())
        changes.extend(self._plan_compat())
        if self.options.shared:
            changes.extend(self._plan_zsh())
        if self.options.plugins:
            changes.extend(self._plan_plugins())
        for name in self.missing:
            changes.append(
                Change("skip", "agent", name, name, reason="CLI not on PATH")
            )
        return [c for c in changes if c is not None]

    # -- skills -----------------------------------------------------------
    def _plan_skills(self):
        changes = []
        skills = catalog.skills()
        known = set(skill.name for skill in skills)
        for agent in self.agents:
            profile = self.profile.agent(agent.name)
            for skill in skills:
                link = os.path.join(agent.skills_dir(), skill.name)
                wanted = profile.is_allowed("skills", skill.name)
                reason = ""
                if profile.is_denied("skills", skill.name):
                    reason = "denied"
                elif profile.is_undecided("skills", skill.name):
                    reason = "undecided: `skill add %s`" % skill.name
                changes.append(_or_report(
                    self._ensure_generated_tree(
                        link, skill.path, "skill", skill.name, agent.name,
                        wanted, reason,
                    ),
                    "skill", skill.name, agent.name, reason,
                ))
            installed = list(self.state.generated(kind="skill", agent=agent.name))
            installed += list(self.state.links(kind="skill", agent=agent.name))
            seen = set()
            for link, meta in installed:
                if link in seen:
                    continue
                seen.add(link)
                if meta.get("name") in known:
                    continue
                changes.append(self._ensure_generated_tree(
                    link, meta.get("target") or "", "skill", meta.get("name"),
                    agent.name, False, "left the catalog"
                ))
        return changes

    # -- mcp --------------------------------------------------------------
    def _plan_mcp(self):
        changes = []
        entries = catalog.mcps()
        known = set(entry.name for entry in entries)
        for agent in self.agents:
            profile = self.profile.agent(agent.name)
            for entry in entries:
                wanted = profile.is_allowed("mcp", entry.name)
                reason = ""
                if profile.is_denied("mcp", entry.name):
                    reason = "denied"
                elif profile.is_undecided("mcp", entry.name):
                    reason = "undecided: `mcp add %s`" % entry.name
                changes.append(_or_report(
                    self._ensure_mcp(agent, entry.name, entry.spec(), wanted, reason),
                    "mcp", entry.name, agent.name, reason,
                ))
            for _key, meta in list(self.state.mcps(agent=agent.name)):
                if meta.get("name") in known:
                    continue
                changes.append(self._ensure_mcp(
                    agent, meta.get("name"), None, False, "left the catalog"
                ))
        return changes

    # -- harness ----------------------------------------------------------
    def _plan_harness(self):
        if not catalog.has_harness():
            return []
        changes = []
        target = paths.harness_file()
        for agent in self.agents:
            wanted = bool(self.profile.agent(agent.name).harness)
            changes.append(self._ensure_generated_markdown(
                agent.harness_path(), target, "harness",
                agent.harness_filename, agent.name, wanted,
                "" if wanted else "harness off for this agent",
                replace_existing=wanted,
            ))
        return changes

    # -- grok's view of ~/.claude/skills ----------------------------------
    def _plan_compat(self):
        grok = next((a for a in self.agents if a.name == "grok"), None)
        if grok is None or not catalog.skills():
            return []
        names = set(skill.name for skill in catalog.skills())
        claude_set = set(
            n for n in names if self.profile.agent("claude").is_allowed("skills", n)
        )
        grok_set = set(
            n for n in names if self.profile.agent("grok").is_allowed("skills", n)
        )
        differs = claude_set != grok_set
        try:
            current, fingerprint = grok.compat_state()
        except AgentConfigError as exc:
            return [Change("skip", "compat", "claude.skills", "grok", reason=str(exc))]

        record = self.state.file_record(grok.mcp_config_path() + "#compat")
        owned = bool(record) and record.get("note") == fingerprint

        if differs:
            if current is False and (owned or record is None):
                return [Change("keep", "compat", "claude.skills", "grok",
                               detail="skills = false")]
            if current is not None and not owned and current is not False:
                return [Change("skip", "compat", "claude.skills", "grok",
                               reason="you set compat.claude.skills")]

            def run(agent=grok):
                _changed, new_fp = agent.set_claude_skills_compat(False)
                self.state.record_file(
                    agent.mcp_config_path() + "#compat", "compat", new_fp
                )
            return [Change(
                "update" if current is not None else "add",
                "compat", "claude.skills", "grok",
                detail="skills = false",
                reason="grok's skills differ from claude's",
                run=run,
            )]

        if current is None:
            return []
        if not owned:
            return [Change("skip", "compat", "claude.skills", "grok",
                           reason="you set compat.claude.skills")]

        def clear(agent=grok):
            agent.clear_claude_skills_compat()
            self.state.forget_file(agent.mcp_config_path() + "#compat")
        return [Change("remove", "compat", "claude.skills", "grok",
                       reason="grok and claude now match", run=clear)]

    # -- zsh --------------------------------------------------------------
    def _plan_zsh(self):
        """`~/.zsh` is a real directory holding one symlink per fragment.

        It used to be a single symlink to the whole catalog, which shipped
        every fragment together — there was no way to take one and leave the
        next. Converting is what makes a fragment declinable.

        Someone else's `~/.zsh` is not moved aside: our links go in beside
        their files, and a name collision is reported rather than resolved.
        """
        if not catalog.has_zsh():
            return []
        fragments = catalog.shell_fragments()
        home_zsh = paths.home_zsh()
        manage = self.profile.manages_zsh
        changes = []

        opening = self._plan_zsh_dir(home_zsh, manage)
        if opening is not None:
            changes.append(opening)
        blocked = opening is not None and opening.verb == "skip"
        # After a conversion the directory is empty. Plan the links against
        # that, not against the files still visible through the old link.
        emptied = opening is not None and opening.verb in ("add", "update")

        known = set()
        for fragment in fragments:
            known.add(fragment.name)
            if blocked:
                changes.append(Change("skip", "shell", fragment.name, None,
                                      reason=opening.reason))
                continue
            wanted = manage and self.profile.is_shell_allowed(fragment.name)
            reason = ""
            if self.profile.is_shell_denied(fragment.name):
                reason = "denied"
            elif self.profile.is_shell_undecided(fragment.name):
                reason = "undecided: tick it in `init`"
            changes.append(_or_report(
                self._ensure_link(
                    os.path.join(home_zsh, fragment.name), fragment.path,
                    "shell", fragment.name, None, wanted, reason,
                    assume_missing=emptied,
                ),
                "shell", fragment.name, None, reason,
            ))

        for link, meta in list(self.state.links(kind="shell")):
            if meta.get("name") in known:
                continue
            changes.append(self._ensure_link(
                link, meta.get("target") or "", "shell", meta.get("name"),
                None, False, "left the catalog",
            ))

        if manage and not blocked:
            changes.append(self._plan_secrets(emptied))
        changes.append(self._plan_zshrc(manage))
        if not manage and not blocked:
            changes.append(self._plan_zsh_dir_cleanup(home_zsh))
        return changes

    def _plan_zsh_dir(self, path, manage):
        """Make `~/.zsh` a directory we can drop links into, or say why not."""
        record = self.state.link_record(path)
        state = self.state

        if os.path.islink(path):
            if not (atomic.is_symlink_to(path, paths.zsh_catalog()) or record):
                return Change("skip", "shell", "~/.zsh", None,
                              reason="a symlink you made")
            if not manage:
                def drop():
                    atomic.remove_link(path)
                    state.forget_link(path)
                return Change("remove", "shell", "~/.zsh", None,
                              detail="link to the whole catalog", run=drop)

            def convert():
                atomic.remove_link(path)
                state.forget_link(path)
                atomic.ensure_dir(path)
                state.record_file(path, "shell-dir", "created by the installer")
            return Change("update", "shell", "~/.zsh", None,
                          detail="one link per fragment",
                          reason="was a link to the whole catalog", run=convert)

        if os.path.isdir(path):
            return None
        if os.path.lexists(path):
            return Change("skip", "shell", "~/.zsh", None,
                          reason="a real file is there; yours, not ours")
        if not manage:
            return None

        def create():
            atomic.ensure_dir(path)
            state.record_file(path, "shell-dir", "created by the installer")
        return Change("add", "shell", "~/.zsh", None,
                      detail=paths.tilde(path), run=create)

    def _plan_zsh_dir_cleanup(self, path):
        """Take back an empty `~/.zsh` we made. Empty is the whole guard:
        `secrets.zsh` lives in there, and it is never ours to delete."""
        state = self.state
        if not state.file_record(path) or not os.path.isdir(path) \
                or os.path.islink(path) or os.listdir(path):
            return None

        def run():
            if not os.listdir(path):
                os.rmdir(path)
                state.forget_file(path)
        return Change("remove", "shell", "~/.zsh", None,
                      detail=paths.tilde(path), reason="empty now", run=run)

    def _plan_secrets(self, emptied=False):
        """`emptied` means an earlier change in this plan replaces `~/.zsh`, so
        anything visible through the old link is about to stop existing — most
        of all `secrets.zsh`, which is the one file here nobody can re-create."""
        example = paths.secrets_example()
        secrets = paths.secrets_file()
        legacy = paths.legacy_secrets_file()
        if not os.path.isfile(example):
            return None
        if not emptied and os.path.exists(secrets):
            return Change("keep", "shell", "secrets.zsh", None,
                          detail=paths.tilde(secrets), reason="never overwritten")

        if os.path.isfile(legacy):
            def move():
                atomic.ensure_dir(os.path.dirname(secrets))
                shutil.copyfile(legacy, secrets)
                os.chmod(secrets, 0o600)
                os.unlink(legacy)
                self.state.record_file(secrets, "secrets", "moved out of the repo")
                ui.say("")
                ui.say("  your secrets are now at " + paths.tilde(secrets))
                ui.say("  they no longer sit inside the repo")
            return Change("update", "shell", "secrets.zsh", None,
                          detail=paths.tilde(secrets),
                          reason="moving out of catalog/zsh", run=move)

        def run():
            atomic.ensure_dir(os.path.dirname(secrets))
            shutil.copyfile(example, secrets)
            os.chmod(secrets, 0o600)
            self.state.record_file(secrets, "secrets", "copied from the example")
        return Change("add", "shell", "secrets.zsh", None,
                      detail=paths.tilde(secrets),
                      reason="empty exports; fill them in by hand", run=run)

    def _plan_zshrc(self, wanted):
        rc = paths.home_zshrc()
        current = atomic.read_text(rc, default="") or ""
        if wanted:
            body = atomic.read_text(paths.zshrc_fragment())
            if body is None:
                return None
            updated, notes = shellrc.apply(current, body)
            if updated == current:
                return Change("keep", "shell", "~/.zshrc", None)
            summary = ", ".join(sorted(set(note[0] for note in notes))) or "updated"

            def run():
                if not self.state.zshrc().get("backup"):
                    backup = atomic.backup_copy(rc, "before-hub-william")
                    if backup:
                        self.state.set_zshrc(backup=backup)
                atomic.atomic_write_text(rc, updated)
                self.state.set_zshrc(
                    managed=True,
                    notes=[list(note) for note in notes],
                )
            return Change("update" if current else "add", "shell", "~/.zshrc", None,
                          detail=summary, run=run)

        if not self.state.zshrc().get("managed"):
            return None
        updated, notes = shellrc.strip(current)
        if updated == current:
            return None

        def undo():
            atomic.atomic_write_text(rc, updated)
            self.state.set_zshrc(managed=False, notes=[list(note) for note in notes])
        return Change("remove", "shell", "~/.zshrc", None,
                      detail="managed block", run=undo)

    # -- plugins ----------------------------------------------------------
    def _plan_plugins(self):
        changes = []
        for plugin in catalog.plugins():
            for agent in self.agents:
                if agent.name not in plugin.agents:
                    continue
                if self.state.plugin_record(agent.name, plugin.name):
                    changes.append(Change("keep", "plugin", plugin.name, agent.name))
                    continue

                def run(agent=agent, plugin=plugin):
                    code, out = agent.plugin_install(plugin)
                    if code != 0:
                        raise ChangeFailed(
                            "%s plugin install failed: %s"
                            % (agent.name, (out or "").strip().splitlines()[-1:] or "")
                        )
                    self.state.record_plugin(agent.name, plugin.name)
                changes.append(Change("add", "plugin", plugin.name, agent.name,
                                      detail="vendor CLI", run=run))
        return changes

    # -- primitives -------------------------------------------------------
    def _ensure_generated_markdown(self, path, source, kind, name, agent,
                                   wanted, reason="", replace_existing=False):
        state = self.state
        display = paths.tilde(path)
        record = state.generated_record(path)
        legacy = state.link_record(path)
        desired = generated.markdown(source, "contributors/default/contributors/default/libraries/harness/AGENTS.md")
        owned = bool(record or legacy or generated.is_markdown(path))
        legacy_link = os.path.islink(path) and atomic.is_symlink_to(path, source)
        owned = owned or legacy_link

        if wanted:
            if not os.path.lexists(path):
                verb, why = "add", ""
            elif generated.markdown_matches(path, desired):
                if record and not legacy:
                    return Change("keep", kind, name, agent, detail=display)
                def adopt():
                    state.record_generated(path, kind, name, agent, source)
                    state.forget_link(path)
                return Change("keep", kind, name, agent, detail=display, run=adopt)
            elif owned:
                verb, why = "update", "regenerating managed copy"
            elif replace_existing:
                verb, why = "update", "replacing previous global harness"
            else:
                return Change("skip", kind, name, agent, detail=display,
                              reason="a real file is there; yours, not ours")

            def install():
                if os.path.lexists(path) and not owned:
                    backup = atomic.backup_once(path, "before-hub-william-harness")
                    if backup:
                        state.record_backup(path, backup, "replaced global harness")
                generated.write_markdown(path, desired)
                state.record_generated(path, kind, name, agent, source)
                state.forget_link(path)
            return Change(verb, kind, name, agent, detail=display,
                          reason=why, run=install)

        if not os.path.lexists(path):
            if record or legacy:
                def forget():
                    state.forget_generated(path)
                    state.forget_link(path)
                return Change("keep", kind, name, agent, detail=display,
                              reason="already gone", run=forget)
            return None
        if not owned:
            return None

        def remove():
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path)
            else:
                os.unlink(path)
            state.forget_generated(path)
            state.forget_link(path)
        return Change("remove", kind, name, agent, detail=display,
                      reason=reason, run=remove)

    def _ensure_generated_tree(self, path, source, kind, name, agent, wanted,
                               reason=""):
        state = self.state
        display = paths.tilde(path)
        record = state.generated_record(path)
        legacy = state.link_record(path)
        legacy_link = bool(source) and os.path.islink(path) \
            and atomic.is_symlink_to(path, source)
        broken_link = os.path.islink(path) and not os.path.exists(path)
        marked = generated.is_tree(path, kind, name, agent)
        owned = bool(record or legacy or legacy_link or broken_link or marked)

        if wanted:
            if not os.path.lexists(path):
                verb, why = "add", ""
            elif source and generated.tree_matches(path, source, kind, name, agent):
                if record and not legacy:
                    return Change("keep", kind, name, agent, detail=display)
                def adopt():
                    state.record_generated(
                        path, kind, name, agent, source,
                        generated.source_fingerprint(source),
                    )
                    state.forget_link(path)
                return Change("keep", kind, name, agent, detail=display, run=adopt)
            elif owned:
                verb = "update"
                why = ("pointed at something that is gone" if broken_link
                       else "regenerating managed copy")
            elif os.path.islink(path):
                return Change("skip", kind, name, agent, detail=display,
                              reason="a symlink you made")
            else:
                return Change("skip", kind, name, agent, detail=display,
                              reason="a real file is there; yours, not ours")

            def install():
                generated.write_tree(source, path, {
                    "kind": kind, "name": name, "agent": agent,
                    "source": "contributors/default/contributors/default/libraries/skills/%s" % name,
                })
                state.record_generated(
                    path, kind, name, agent, source,
                    generated.source_fingerprint(source),
                )
                state.forget_link(path)
            return Change(verb, kind, name, agent, detail=display,
                          reason=why, run=install)

        if not os.path.lexists(path):
            if record or legacy:
                def forget():
                    state.forget_generated(path)
                    state.forget_link(path)
                return Change("keep", kind, name, agent, detail=display,
                              reason="already gone", run=forget)
            return None
        if not owned:
            return None

        def remove():
            generated.remove_tree(path)
            state.forget_generated(path)
            state.forget_link(path)
        return Change("remove", kind, name, agent, detail=display,
                      reason=reason, run=remove)

    def _ensure_link(self, link_path, target, kind, name, agent, wanted,
                     reason="", assume_missing=False, replace_existing=False):
        """`assume_missing` is for paths an earlier change in this same plan
        will have cleared by the time these closures run."""
        state = self.state
        record = state.link_record(link_path)
        display = paths.tilde(link_path)

        if assume_missing or not os.path.lexists(link_path):
            if wanted:
                def run():
                    atomic.symlink(target, link_path)
                    state.record_link(link_path, kind, name, agent, target)
                return Change("add", kind, name, agent, detail=display, run=run)
            if record:
                def forget():
                    state.forget_link(link_path)
                return Change("keep", kind, name, agent, detail=display,
                              reason="already gone", run=forget)
            return None

        if not os.path.islink(link_path):
            if wanted:
                if replace_existing:
                    def replace_file():
                        backup = atomic.backup_once(
                            link_path, "before-hub-william-harness"
                        )
                        if backup:
                            state.record_backup(
                                link_path, backup, "replaced global harness"
                            )
                        atomic.symlink(target, link_path)
                        state.record_link(link_path, kind, name, agent, target)
                    return Change("update", kind, name, agent, detail=display,
                                  reason="replacing previous global harness",
                                  run=replace_file)
                return Change("skip", kind, name, agent, detail=display,
                              reason="a real file is there; yours, not ours")
            return None

        # A link into our own catalog is ours whatever `applied.json` says. That
        # matters after the state file is lost: without it a deny would stop
        # uninstalling anything, silently.
        points_here = bool(target) and atomic.is_symlink_to(link_path, target)
        if wanted:
            if record is None and not points_here:
                # A link to nothing is nobody's: it does not resolve, so it is
                # not doing a job for anyone. This is what lets a checkout that
                # moved — a worktree deleted, ~/.hub-william renamed — be
                # repaired instead of reported at every name it once owned.
                if not os.path.exists(link_path):
                    def repair():
                        atomic.symlink(target, link_path)
                        state.record_link(link_path, kind, name, agent, target)
                    return Change("update", kind, name, agent, detail=display,
                                  reason="pointed at something that is gone",
                                  run=repair)
                if replace_existing:
                    def replace_link():
                        backup = atomic.backup_once(
                            link_path, "before-hub-william-harness"
                        )
                        if backup:
                            state.record_backup(
                                link_path, backup, "replaced global harness"
                            )
                        atomic.symlink(target, link_path)
                        state.record_link(link_path, kind, name, agent, target)
                    return Change("update", kind, name, agent, detail=display,
                                  reason="replacing previous global harness",
                                  run=replace_link)
                return Change("skip", kind, name, agent, detail=display,
                              reason="a symlink you made")
            if points_here:
                if record is None:
                    def adopt():
                        state.record_link(link_path, kind, name, agent, target)
                    return Change("keep", kind, name, agent, detail=display, run=adopt)
                return Change("keep", kind, name, agent, detail=display)

            def relink():
                atomic.symlink(target, link_path)
                state.record_link(link_path, kind, name, agent, target)
            return Change("update", kind, name, agent, detail=display,
                          reason="pointed somewhere else", run=relink)

        if record is None and not points_here:
            return None

        def unlink():
            atomic.remove_link(link_path)
            state.forget_link(link_path)
        return Change("remove", kind, name, agent, detail=display,
                      reason=reason, run=unlink)

    def _mcp_twin(self, agent, name, spec):
        """Another name in this agent's config already pointing at the same
        server, or None.

        Registering a second one is not harmless. The agent gets two copies of
        every tool, and where credentials are keyed by name — grok stores them
        as `<name>:<url>` — the copy asks you to log in again for a server you
        already authenticated, which reads as the login having failed.
        """
        if not spec:
            return None
        for other in agent.mcp_names():
            if other == name:
                continue
            try:
                stored, _fingerprint = agent.mcp_get(other)
            except AgentConfigError:
                continue
            if stored is not None and agent.mcp_matches(stored, spec):
                return other
        return None

    def _ensure_mcp(self, agent, name, spec, wanted, reason=""):
        state = self.state
        try:
            stored, current = agent.mcp_get(name)
        except AgentConfigError as exc:
            return Change("skip", "mcp", name, agent.name, reason=str(exc))
        record = state.mcp_record(agent.name, name)
        owned = bool(record) and current is not None and record.get("fingerprint") == current

        if wanted:
            if stored is None:
                twin = self._mcp_twin(agent, name, spec)
                if twin:
                    return Change("skip", "mcp", name, agent.name,
                                  detail=_spec_summary(spec),
                                  reason="same server, already here as `%s`" % twin)

                def add(agent=agent, name=name, spec=spec):
                    _changed, fingerprint = agent.mcp_upsert(name, spec)
                    state.record_mcp(agent.name, name, fingerprint)
                return Change("add", "mcp", name, agent.name,
                              detail=_spec_summary(spec), run=add)
            if owned:
                if agent.desired_mcp_fingerprint(name, spec) == current:
                    return Change("keep", "mcp", name, agent.name,
                                  detail=_spec_summary(spec))

                def update(agent=agent, name=name, spec=spec):
                    _changed, fingerprint = agent.mcp_upsert(name, spec)
                    state.record_mcp(agent.name, name, fingerprint)
                return Change("update", "mcp", name, agent.name,
                              detail=_spec_summary(spec),
                              reason="the catalog entry changed", run=update)

            why = "you edited this block" if record else "already configured, not by us"
            if agent.mcp_matches(stored, spec) and not record:
                return Change("keep", "mcp", name, agent.name,
                              detail=_spec_summary(spec),
                              reason="already configured the same way")
            if self.options.force_mcp:
                def force(agent=agent, name=name, spec=spec):
                    _changed, fingerprint = agent.mcp_upsert(name, spec)
                    state.record_mcp(agent.name, name, fingerprint)
                return Change("update", "mcp", name, agent.name,
                              detail=_spec_summary(spec),
                              reason="--force-mcp over: " + why, run=force)
            return Change("skip", "mcp", name, agent.name, reason=why)

        if stored is None:
            if record:
                def forget(agent=agent, name=name):
                    state.forget_mcp(agent.name, name)
                return Change("keep", "mcp", name, agent.name,
                              reason="already gone", run=forget)
            return None
        def remove(agent=agent, name=name):
            agent.mcp_remove(name)
            state.forget_mcp(agent.name, name)

        if owned:
            return Change("remove", "mcp", name, agent.name, reason=reason, run=remove)

        why = "you edited this block" if record else "not ours to remove"
        # Lose `applied.json` and every block becomes unremovable, which turns
        # a deny into a permanent report. Generated markers and catalog
        # symlinks can prove ownership, but a config block cannot, so the way
        # out is the same flag that overrides ownership when writing.
        if self.options.force_mcp:
            return Change("remove", "mcp", name, agent.name,
                          reason="--force-mcp over: " + why, run=remove)
        return Change("skip", "mcp", name, agent.name,
                      reason=why + "; --force-mcp to remove it anyway")

    # -- applying ---------------------------------------------------------
    def apply(self, changes):
        failures = []
        for change in changes:
            if change.run is None:
                continue
            if change.verb == "skip":
                continue
            try:
                change.run()
            except (ChangeFailed, AgentConfigError, OSError, IOError) as exc:
                change.error = str(exc)
                failures.append(change)
        self.state.save()
        return failures


class ChangeFailed(Exception):
    pass


def _or_report(change, kind, name, agent, reason):
    """Nothing to do is usually silence. An undecided item is not: it is in the
    catalog, nobody said no, and it is still not installed — say so."""
    if change is not None:
        return change
    if reason.startswith("undecided"):
        return Change("skip", kind, name, agent, reason=reason)
    return None


def _spec_summary(spec):
    if not spec:
        return ""
    if "url" in spec:
        return spec["url"]
    return " ".join([spec.get("command", "")] + list(spec.get("args") or [])).strip()


# --------------------------------------------------------------------------
# agent scope
# --------------------------------------------------------------------------

class ScopeError(Exception):
    pass


def resolve_agents(spec):
    """(agents, missing, explicit).

    No `--agent`: every CLI on PATH, and a missing one is a reported skip.
    `--agent all`: same PATH rule, but the operator named it, so a deny may be
    lifted. `--agent grok` with no grok on PATH is an error, not a skip.
    """
    if spec is None:
        names, explicit = list(AGENT_NAMES), False
    elif spec.strip() == "all":
        names, explicit = list(AGENT_NAMES), True
    else:
        names = [part.strip() for part in spec.split(",") if part.strip()]
        if not names:
            raise ScopeError(
                "--agent needs at least one of %s or all" % ", ".join(AGENT_NAMES)
            )
        unknown = [n for n in names if n not in AGENT_NAMES]
        if unknown:
            raise ScopeError(
                "unknown agent %s; use %s or all"
                % (", ".join(unknown), ", ".join(AGENT_NAMES))
            )
        explicit = True

    present, missing = [], []
    for name in names:
        agent = get_agent(name)
        if agent.available():
            present.append(agent)
        else:
            missing.append(name)

    named_one_by_one = explicit and spec.strip() != "all"
    if named_one_by_one and missing:
        raise ScopeError(
            "%s is not on PATH; install it first, or drop --agent to skip it"
            % ", ".join(missing)
        )
    return present, missing, explicit
