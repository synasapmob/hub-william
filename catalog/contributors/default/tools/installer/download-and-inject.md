# Downloading a document instead

Every document on the canvas can be saved from its own panel — one file, or the
whole category as a zip that keeps each file's path.

This is for reading, for quoting in a review, and for vendoring a contract into
another repository. It is not an install: a downloaded file still has to land
under the right name in the right directory before any agent reads it, and
keeping it up to date afterwards is on you.

## If you only want one contract

Save the `.md`, then put it where your agent looks:

| Agent | Always-on file | Skills |
| --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/skills/<name>/SKILL.md` |
| Codex | `~/.codex/AGENTS.md` | — |
| Grok | `~/.grok/AGENTS.md` | `~/.grok/skills/<name>/SKILL.md` |

A harness contract is not loaded on its own. It is reached from the dispatcher
in the always-on file, so a tag contract dropped in beside it does nothing until
something points at it.

## Why the installer exists

Because of the paragraph above. Paths, names, per-agent differences and removal
are the whole job, and doing them by hand once is fine while doing them on three
machines is not.
