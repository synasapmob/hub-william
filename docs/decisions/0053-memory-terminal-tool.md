# ADR-0053: Memory, a terminal tool for what coding agents remember

- Status: Accepted
- Date: 2026-10-26
- Authority: operator asked for a tool to see and manage the memory their coding agents keep, drawn like a terminal, with a screen per agent, then per global area or project, a read-only view of files, and a `D` key that deletes what the screen is about. It replaces an earlier idea of a tool for the agents' disk cache.

## Context

"Memory" means two things:

1. **Instruction files**: files the operator writes and the agent reads, such as
   `CLAUDE.md`, `AGENTS.md` and `GEMINI.md`.
2. **Learned memory**: lessons the agent saves about the operator and the project, such as
   "never call `useEffect` in a utils helper".

Where each agent keeps them. A path marked "seen" exists on the operator's machine; the rest
comes from the agents' documentation and was not run:

| Agent  | Instruction files                                                                                         | Learned memory                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Claude | `~/.claude/CLAUDE.md` (seen, a symlink); a project's `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`  | `~/.claude/projects/<project>/memory/`, a `MEMORY.md` index and topic files (seen: 28 folders, all empty)     |
| Codex  | `~/.codex/AGENTS.md` (seen, a symlink)                                                                    | `~/.codex/memories_1.sqlite` (seen, table `stage1_outputs`, no rows); the docs also name `~/.codex/memories/` |
| Gemini | `~/.gemini/AGENTS.md` (seen, a symlink); the docs name `~/.gemini/GEMINI.md`, where `save_memory` appends | in `GEMINI.md`, under "Gemini Added Memories" (not seen)                                                      |
| Shared | `~/.agents/AGENTS.md` (seen), the file the three symlinks above point to                                  | none                                                                                                          |

On that machine the operator's rules keep agents from saving memory on their own, so the learned
memory is empty and most of what the tool shows is instruction files. A page on the deployed
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
error, and `--list` prints the table instead and changes nothing. `--home=PATH` scans another
home folder, which the tests rely on.

**Screens.** The first screen lists the four agents (`claude`, `codex`, `gemini`, `shared`), each
with `PATHS` (files, or memories in a database), `SIZE`, `AGE` and `TYPE`: `rules`, `learned` or
`mixed`. An agent whose folder does not exist is listed as `missing`, and one with nothing in it as
`empty`, with dashes for the numbers; Right on such a row says why it cannot be opened. Right opens
a row and Left goes back:

- Claude shows `Global` (its instruction file) and one row per project that has something: the
  project's `memory` folder and its instruction files. Claude names a project's folder after its
  path with `/` and `.` both written as `-`, so the script decodes the name only to a path that
  exists, and shows the raw name otherwise. Project instruction files are found only for projects
  Claude lists.
- Codex, Gemini and shared show their files directly. A Codex memory database shows one read-only
  row per memory.

An entry whose size is zero is never listed below an agent, and `PATHS` counts only what could be
listed. Sizes are the text sizes. A symlinked instruction file shows its target and counts the
target's size, so the shared file appears once for each agent that links to it. A `disk` tab is
drawn but not built yet.

**Reading.** Right on a file opens a read-only view with long lines wrapped. The arrows scroll
and go round: past the last row comes the first, and above the first the last. `PgUp`, `PgDn`,
`g`, `G`, `Home` and `End` work, and so do the arrows held with Ctrl, Option or Cmd (which a
terminal may keep for itself). Only the hints `[↑↓] move  [←] back` and `[q] quit` are shown. Only
text is shown: a file with a NUL byte near its start, or that is not UTF-8, is not opened. At most
the first 256 KB is read. `.json` is pretty-printed and `p` toggles it; for `.jsonl`, `p` spreads
each record. Control characters are replaced so a file cannot send escape sequences to the
terminal. A file is opened with `O_NOFOLLOW` and only if it is a regular file; a symlinked
instruction file is read through its link. The view cannot edit or delete. Unknown key sequences
are swallowed, so they never act as other keys.

**`D` acts on the row under the cursor** (`d` and `D` both work). It previews what will move and
what is kept, then asks `y/N` with no as the default. Only learned memory in files and folders can
move to the Trash. Instruction files and databases are read-only here, because deleting
`~/.agents/AGENTS.md` would change every agent and a database belongs to a running program. A row
with nothing deletable says so, and so does a missing or empty agent.

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
of a database; OpenCode and DSH, where no memory files were found; project instruction files for
projects Claude does not list; the disk tab; and Windows.

## Consequences

- The tool is only as complete as the paths in its table. An agent can move its memory in a new
  version, and a path that exists nowhere is simply not shown.
- Codex's memory database layout (`stage1_outputs`) was read from one machine, which had no rows.
  A different layout is shown as a database the tool does not know, not read.
- The script is about 48 KB, bundled into the frontend as text with the other catalogue files.
- nginx serves `/catalog/*.py` as text, as it does `.sh`, so the link opens in the browser. curl is
  unaffected.
- `curl | python3` trusts the site's origin, as the installers do. The script can also be
  downloaded and read first.
- The Linux Trash path is covered by tests that patch the platform and by CI, and was not run by
  hand on Linux. The macOS move into `~/.Trash` was run once on a probe file.
