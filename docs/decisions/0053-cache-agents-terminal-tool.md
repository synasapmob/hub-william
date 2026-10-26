# ADR-0053: Cache agents, a terminal tool for what agents keep on disk

- Status: Accepted
- Date: 2026-10-26
- Authority: operator asked for a tool that shows how much disk the coding agents use and clears their cache, drawn like a terminal, with a screen per agent, then per global area or project, and a `D` key that deletes what the screen is about.

## Context

Claude Code, Codex and Gemini each keep a folder in the home folder (`~/.claude`,
`~/.codex`, `~/.gemini`). Nothing shows how large they are or what is safe to remove.
A page on the deployed site cannot read a visitor's disk, so the tool has to run on
the user's own machine, like the installers and `link-skills`.

## Decision

`contributors/synasapmob/tools/cache-agents/cache-agents.py` is one script that uses
only Python's standard library (3.9 or newer, macOS and Linux). It is published like
any other catalogue file and appears at `/tools/synasapmob` as the card CACHE AGENTS.

```sh
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/cache-agents/cache-agents.py | python3
```

It reads and writes only under the home folder and makes no network request. When the
script itself arrives on stdin it reads the keyboard from `/dev/tty`. Without a
terminal it exits with an error, and `--list` prints the table instead and changes
nothing. `--home=PATH` scans another home folder, which the tests rely on.

**Screens.** The first screen lists the agents found, then each screen lists what is
inside the row you open with Right or Enter, and Left goes back:

1. Agents: `NAME`, `PATHS`, `SIZE`, `AGE`, `KIND`.
2. One agent: `Global` (the agent's own folder) and one row per project. An agent
   without a project folder lists its entries directly.
3. Any folder below, down to files.

`SIZE` is disk usage, with a hard-linked file counted once. `AGE` is the newest change
inside the row. An entry whose size is zero is never listed, and `PATHS` counts only
what could be listed, so an agent's total is the sum of the rows on its screen.
Symlinks are one path and are never followed. Claude names a project's
folder after its path with `/` and `.` both written as `-`, so the script decodes the
name only to a path that exists, and shows the raw name otherwise. A `disk` tab is
drawn but not built yet.

**Cache and data.** The script has a table of the top-level entries that are cache,
chosen from their folder names, not from the agents' documentation and without
opening their contents:

| Agent  | Cache                                                                 |
| ------ | --------------------------------------------------------------------- |
| claude | `cache`, `shell-snapshots`, `paste-cache`, `telemetry`, `session-env` |
| codex  | `cache`                                                               |
| gemini | none yet                                                              |

Everything else is data and is shown as `keep`: project transcripts and memory,
settings, skills, history, databases, installed packages. `KIND` is `cache`, `keep`,
or `mixed` for a row that holds both.

**`D` depends on where you are.** On the first screen it deletes all cache of every
agent, after a preview, and the user must type `DELETE <size>`. On any other screen it
deletes the cache under the cursor, an agent's `Global`, one folder or one file, after
the same preview and a `y/N` question that defaults to no. A row with no cache shows
that nothing can be deleted. Lowercase `d` only reminds the user to press `D`. The
preview warns that a running agent may still use the folders.

**Deleting is a move to the Trash, never a delete.** The Trash is `~/.Trash` on macOS
(no "Put Back" record is written) and the freedesktop Trash elsewhere, with its
`.trashinfo` record. Before each move the script checks again that the entry is cache,
sits under the agent's real folder, is on the table above, is not reached through a
symlink and still exists. A move that fails is reported and is never retried as a
permanent delete.

**Left out on purpose.** Deleting transcripts or old projects, removing git worktrees
(a repository's `.claude/worktrees/` can hold several gigabytes, but each one is a
registered branch that may hold unpushed work, so it needs `git worktree remove` and
not the Trash), spotting projects whose folder is gone, the disk tab, and Windows.
Each needs an operator decision first.

## Consequences

- Cache alone is small. The folders that take space are mostly data, so a typical `D`
  frees little until a later decision allows more.
- The table of cache folders is a snapshot of how the agents behave today. A new
  version of an agent can add a folder, and nothing deletes it until the table
  names it.
- The script is about 33 KB, bundled into the frontend as text with the other
  catalogue files.
- nginx serves `/catalog/*.py` as text, as it does `.sh`, so the link opens in the
  browser. curl is unaffected.
- `curl | python3` trusts the site's origin, as the installers do. The script can
  also be downloaded and read first.
- The Linux Trash path is covered by tests that patch the platform, and was not run
  on a Linux machine. The macOS move into `~/.Trash` was run once on a probe file.
