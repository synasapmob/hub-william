# ADR-0053: Memory, a terminal tool for what coding agents remember

- Status: Accepted
- Date: 2026-10-26
- Authority: operator asked for a tool to see and manage the memory their coding agents keep, drawn like a terminal, with a screen per agent, then per global area or project, a read-only view of files, and a `D` key that deletes what the screen is about. It replaces an earlier idea of a tool for the agents' disk cache. The rules and skills the operator gives the agents are a separate tab, which comes in a later change.

## Context

"Memory" here means the lessons an agent saves about the operator and the project, such as
"never call `useEffect` in a utils helper". It is not the instruction files the operator writes
(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) or the skills, which the agents read but do not write.

Where each agent keeps it. "Seen" means it exists on the operator's machine; "tried" means an
agent was run there with a made-up placeholder; the rest comes from the agents' documentation:

| Agent  | Learned memory                                                                                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude | `~/.claude/projects/<project>/memory/`: a `MEMORY.md` index and topic files, one folder per project and per worktree (tried: a saved note landed there, and Claude Code added metadata lines to it)                                                                                                                |
| Codex  | `~/.codex/memories/`, a git repository with `raw_memories.md` and an `extensions/` folder, plus `~/.codex/memories_1.sqlite`; both are global. The feature is off by default; one short run with it on created the folder but did not save the placeholder, which fits memory being built later from past sessions |
| Grok   | `~/.grok/memory-v2/global/` and `workspaces/<name>-<hash>/`, each with `topics/`, `observations/_inbox/` and a generated `MEMORY.md` (tried: a saved note landed in `global/topics/`). Off by default; worktrees of one repository share a workspace                                                               |
| agy    | not identified: agy keeps its conversations under `~/.gemini/antigravity-cli/` and a headless run refused to save a note                                                                                                                                                                                           |

Claude has no global memory, only one per project. On the operator's machine the shared rules
keep agents from saving memory on their own, so there the memory is empty. A page on the deployed
site cannot read a visitor's disk, so the tool has to run on the user's own machine, like the
installers and `link-skills`.

## Decision

`contributors/synasapmob/tools/memory/memory.py` is one script that uses only Python's standard
library (3.9 or newer, macOS and Linux). It is published like any other catalogue file and appears
at `/tools/synasapmob` as the card MEMORY.

```sh
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/memory/memory.py | python3
```

It reads and writes only under the home folder and makes no network request. When the script
itself arrives on stdin it reads the keyboard from `/dev/tty`. Without a terminal it exits with an
error, and `--list` prints the table instead and changes nothing (`--agent=NAME` for one agent).
`--home=PATH` scans another home folder, which the tests rely on.

**Tabs.** `1` disk and `2` memory (or Tab to go between them) switch tabs. The tool starts on
`memory`, and `r` rescans it. A `disk` tab is drawn but not built yet.

**The memory tab** lists the four agents (`claude`, `codex`, `grok`, `agy`), each with `PATHS`
(files, or memories in a database), `SIZE`, `AGE` and `TYPE`: `memory` (what an agent saved
itself) or `empty`. An agent whose folder does not exist, or that has no memory, is listed as
`empty`, with dashes for the numbers; Right on such a row says which of the two it is and why it
cannot be opened. Right opens a row and Left goes back:

- Claude shows one row per project that has memory: the project's `memory` folder. Claude names a
  project's folder after its path with `/` and `.` both written as `-`, so the script decodes the
  name only to a path that exists (comparing each real folder name with its dots written as `-`,
  which covers `my.app`, `.claude` and a folder that starts with `-`), and shows the raw name
  otherwise. How Claude writes other characters, such as spaces, was not checked.
- Grok shows `Global` (the generated index, and the global topics and observations) and one row per workspace, named without the trailing hash. Its state files (a database, a search index, archived observations) are never listed, and the generated `MEMORY.md` is read-only and is shown only next to notes it indexes, so a scope with an index but no notes is not listed.
- Codex shows its files directly. A Codex memory database with no memories is not listed; one with memories shows one read-only
  row per memory. agy has no memory the tool knows of, so it is always `empty`.

An entry whose size is zero is never listed below an agent, and `PATHS` counts only what could be
listed. Sizes are the text sizes.

**Reading.** Right on a file opens a read-only view with long lines wrapped. The arrows scroll
and go round: past the last row comes the first, and above the first the last. `PgUp`, `PgDn`,
`g`, `G`, `Home` and `End` work, and so do the arrows held with Ctrl, Option or Cmd (which a
terminal may keep for itself). Only the hints `[↑↓] move  [←] back` and `[q] quit` are shown. Only
text is shown: a file with a NUL byte near its start, or that is not UTF-8, is not opened. At most
the first 256 KB is read. `.json` is pretty-printed and `p` toggles it; for `.jsonl`, `p` spreads
each record. Control characters are replaced so a file cannot send escape sequences to the
terminal. A file is opened with `O_NOFOLLOW` and only if it is a regular file. The view cannot
edit or delete. Unknown key sequences are swallowed, so they never act as other keys.

**`D` acts on the row under the cursor** (`d` and `D` both work). It previews what will move and
what is kept, then asks `y/N` with no as the default. A row deletes what it holds: a file moves as
a file, a folder as a folder, and a group row (an agent, `Global`, a project) moves each memory
file or folder under it. Generated indexes and databases are read-only, because a database belongs
to a running program. A row with nothing deletable says so, and so does a missing or empty agent.

The preview lists every item, and a long one scrolls: the arrows, `PgUp`, `PgDn`, `g` and `G` move
through it and `rows 4-11 of 18` says which part is shown. Scrolling never cancels. `y` moves every
item in it, not only the ones on screen; `Esc`, `n` or Enter cancel, `q` quits the tool without
moving anything, and any other key does nothing. Only `[↑↓] move`, `[Esc] cancel` and `[q] quit`
are shown, under the question, whether or not the list is long enough to scroll.

**Deleting is a move to the Trash, never a delete.** The Trash is `~/.Trash` on macOS (no "Put
Back" record is written) and the freedesktop Trash elsewhere, with its `.trashinfo` record. The
Trash name carries the agent and the end of the project name. Before each move the script checks
again that the entry is learned memory, sits under the agent's memory root, is in the folder the
agent writes memory to, is not reached through a symlink and still exists. A move that fails is
reported and is never retried as a permanent delete.

**Position.** Each folder remembers which row the cursor was on while the tool runs, so going back
into a folder returns to the same row. This lives in memory only: the tool writes no state file,
and a new run starts at the first screen.

**Left out on purpose.** Editing or adding memory; removing a deleted topic file's line from
Claude's `MEMORY.md` index (it may keep a line that points at a file that is gone); deleting rows
of a database; the instruction files and skills (a later tab); OpenCode, OMP and DSH, where no
memory files were found; agy's own memory, which was not identified; the disk tab; and Windows.

## Consequences

- The tool is only as complete as the paths in its table. An agent can move its memory in a new
  version, and a path that exists nowhere is simply not shown.
- Codex's memory database layout (`stage1_outputs`) was read from one machine, which had no rows.
  A different layout is shown as a database the tool does not know, not read.
- The script is about 50 KB, bundled into the frontend as text with the other catalogue files.
- nginx serves `/catalog/*.py` as text, as it does `.sh`, so the link opens in the browser. curl is
  unaffected.
- `curl | python3` trusts the site's origin, as the installers do. The script can also be
  downloaded and read first.
- The Linux Trash path is covered by tests that patch the platform and by CI, and was not run by
  hand on Linux. The macOS move into `~/.Trash` was run once on a probe file.
