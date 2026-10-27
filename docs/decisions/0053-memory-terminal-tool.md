# ADR-0053: Memory, a terminal tool for what coding agents remember and are told

- Status: Accepted
- Date: 2026-10-26
- Authority: operator asked for a tool to see and manage the memory their coding agents keep, drawn like a terminal, with a screen per agent, then per global area or project, a read-only view of files, and a `D` key that deletes what the screen is about. It replaces an earlier idea of a tool for the agents' disk cache. The operator then asked for the rules and skills to move to a tab of their own, so that the memory tab shows memory only, and that `D` work on them as it does on memory: a file, a folder or a link, and a group of them.

## Context

The tool shows three kinds of thing, and keeps them on two tabs:

1. **Learned memory** (the `memory` tab): lessons the agent saves about the operator and the
   project, such as "never call `useEffect` in a utils helper".
2. **Instruction files** (the `rules` tab): files the operator writes and the agent reads, such as
   `CLAUDE.md`, `AGENTS.md` and `GEMINI.md`.
3. **Skills** (the `rules` tab): folders with a `SKILL.md` that an agent loads when a task
   matches.

Where each agent keeps them. "Seen" means it exists on the operator's machine; "tried" means an
agent was run there with a made-up placeholder; the rest comes from the agents' documentation:

| Agent  | Instruction files                                                                                        | Skills                                                                                                                                    | Learned memory                                                                                                                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude | `~/.claude/CLAUDE.md` (seen, a symlink); a project's `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` | `~/.claude/skills/<name>/` (seen, links to `~/.agents/skills`), and `skills/synced/<id>/<name>/` for skills synced from an account (seen) | `~/.claude/projects/<project>/memory/`: a `MEMORY.md` index and topic files, one folder per project and per worktree (tried: a saved note landed there, and Claude Code added metadata lines to it)                                                                                                                |
| Codex  | `~/.codex/AGENTS.md` (seen, a symlink)                                                                   | `~/.codex/skills/.system/<name>/` (seen, Codex's own)                                                                                     | `~/.codex/memories/`, a git repository with `raw_memories.md` and an `extensions/` folder, plus `~/.codex/memories_1.sqlite`; both are global. The feature is off by default; one short run with it on created the folder but did not save the placeholder, which fits memory being built later from past sessions |
| Grok   | `~/.grok/rules/*.md`; a project's `AGENTS.md` or `CLAUDE.md` (from its manual)                           | `~/.grok/skills/<name>/` (from its manual, not seen); `~/.grok/bundled/skills/` ships with Grok and is not shown                          | `~/.grok/memory-v2/global/` and `workspaces/<name>-<hash>/`, each with `topics/`, `observations/_inbox/` and a generated `MEMORY.md` (tried: a saved note landed in `global/topics/`). Off by default; worktrees of one repository share a workspace                                                               |
| agy    | `~/.gemini/AGENTS.md` (seen, a symlink); `GEMINI.md` is named by the Gemini CLI docs but was not seen    | `~/.gemini/config/skills/<name>/` (seen, links to `~/.agents/skills`)                                                                     | not identified: agy keeps its conversations under `~/.gemini/antigravity-cli/` and a headless run refused to save a note                                                                                                                                                                                           |

The three symlinks seen above (Claude, Codex and agy) all point at one file, `~/.agents/AGENTS.md`, so a change to it
reaches every agent, and the skill links of Claude and agy all point into `~/.agents/skills/`. On that machine the
operator's rules keep agents from saving memory on their own, so the learned memory is empty and
most of what the tool shows is rules and skills. A page on the deployed
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
error, and `--list` prints the table instead and changes nothing (`--tab=rules` prints the rules
tab, `--agent=NAME` one agent). `--home=PATH` scans another home folder, which the tests rely on.

**Tabs.** `1` disk, `2` memory and `3` rules (or Tab to go round) switch tabs. The tool starts on
`memory`. Each of the two list tabs keeps its own folder and cursor while the tool runs, and `r`
rescans the tab on screen. A `disk` tab is drawn but not built yet.

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

**The rules tab** lists `~/.agents` first, because it is global and the other agents link to it,
then `claude`, `codex`, `grok` and `agy` by size, with the same columns
and the types `rules` (instruction files), `skills`, `mixed` (both) or `empty`. Files, skill
folders and links can be moved to the Trash from it, as on the memory tab (see `D` below).

- Claude shows `Global` (`CLAUDE.md` and the `skills` folder) and one row per project with an
  instruction file (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `AGENTS.md`,
  `GEMINI.md`). Project instruction files are found only for projects Claude lists.
- Codex, agy and `~/.agents` show their instruction files and a `skills` folder; Grok shows the
  `.md` files of `~/.grok/rules` and its `skills` folder. Codex's own `.system` skills are shown,
  as the only skills Codex has on the machine where it was checked; the skills Grok ships with
  (`~/.grok/bundled/skills`, 412 files there) are not shown.
- A skill is a folder that holds a `SKILL.md`, and opening it lists its files. A folder that is not
  a skill is a group of them, so `synced` holds the synced skills, without the account folder
  between. A linked skill shows its target. Names that start with a dot, and links to folders
  inside a skill, are not listed.
- `~/.agents` is a row of its own because it is where the files the other agents link to really
  live. A symlinked file shows its target and counts the target's size, so the shared
  `~/.agents/AGENTS.md` is counted for each agent that links to it, and again under `~/.agents`.

On both tabs, an entry whose size is zero is never listed below an agent, and `PATHS` counts only
what could be listed. Sizes are the text sizes.

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

**`D` acts on the row under the cursor, on the memory tab and on the rules tab** (`d` and `D`
both work). It previews what will move and what is kept, then asks `y/N` with no as the default.
A row deletes what it holds: a file moves as a file, a folder as a folder, a link as a link, and a
group row (an agent, `Global`, a project, `skills`, `synced`) moves each file, skill folder or
link under it. Generated indexes and databases are read-only, because a database belongs to a
running program. A row with nothing deletable says so, and so does a missing or empty agent.

The preview lists every item, and a long one scrolls: the arrows, `PgUp`, `PgDn`, `g` and `G` move
through it and `rows 4-11 of 18` says which part is shown. Scrolling never cancels. `y` moves every
item in it, not only the ones on screen; `Esc`, `n` or Enter cancel, `q` quits the tool without
moving anything, and any other key does nothing. Only `[↑↓] move`, `[Esc] cancel` and `[q] quit`
are shown, under the question, whether or not the list is long enough to scroll.

On the rules tab:

- A link moves alone and its target stays. The preview marks it `link` and counts the targets
  that stay.
- A real file or folder, such as one under `~/.agents`, moves as it is, and the links that pointed
  at it are left dangling. The preview lists the links the tool lists, with their paths, before asking
  (`Would break 7 links:` and one row for each); a link that moves in the same plan is not counted.
  Afterwards each such link is listed as broken (see below), so the folder it sits in does not
  disappear.
- A **broken link** is a symlink whose target is not there (or whose links go round in a circle).
  It is listed in red with the type `broken`, no size and the target it points at, and the rows
  above it stay visible while it is the only thing left. This is common: a project may keep
  `AGENTS.md` as a symlink to `CLAUDE.md`, so deleting `CLAUDE.md` leaves `AGENTS.md` broken.
  Right on it looks at the link again and, if it is still broken, shows a warning (the link, the
  target that was not found, and that nothing was changed) instead of a file; if it was mended since
  the scan it reads the file. The tool never mends a link. `D` on it moves just the link, like any
  link. Only the rules tab lists broken links: a broken index link in the memory tab is ignored.
- Deleting an agent moves its project instruction files too, such as a project's `CLAUDE.md`,
  which may be tracked in that project's repository. The preview names every path.
- Rules and skills are not memory, so the memory tab never moves them and the rules tab never
  moves memory.

**Deleting is a move to the Trash, never a delete.** The Trash is `~/.Trash` on macOS (no "Put
Back" record is written) and the freedesktop Trash elsewhere, with its `.trashinfo` record. The
Trash name carries the agent and the end of the folder name. Before each move the script checks
again that the entry is of the kind its tab holds (learned memory, or a rule or skill), is in the
list of places recorded when it was scanned, and still exists. A memory entry must not be reached
through a symlink. A rule, skill or link must still be what was listed: a link must still be a link
and a file must not have become one, so a swap can never make the tool move a link's target, and
the folder that holds it must not be a symlink. A move that fails is reported and is never
retried as a permanent delete.

**Position.** Each folder of each tab remembers which row the cursor was on while the tool runs, so going back
into a folder returns to the same row. This lives in memory only: the tool writes no state file,
and a new run starts at the first screen.

**Left out on purpose.** Editing or adding memory; removing a deleted topic file's line from
Claude's `MEMORY.md` index (it may keep a line that points at a file that is gone); deleting rows
of a database; editing rules and skills; OpenCode, OMP and DSH, where no memory files
were found; agy's own memory, which was not identified; project instruction files for
projects Claude does not list; the skills Grok ships with; the disk tab; and Windows.

## Consequences

- The tool is only as complete as the paths in its table. An agent can move its memory in a new
  version, and a path that exists nowhere is simply not shown.
- Codex's memory database layout (`stage1_outputs`) was read from one machine, which had no rows.
  A different layout is shown as a database the tool does not know, not read.
- The script is about 64 KB, bundled into the frontend as text with the other catalogue files.
- nginx serves `/catalog/*.py` as text, as it does `.sh`, so the link opens in the browser. curl is
  unaffected.
- `curl | python3` trusts the site's origin, as the installers do. The script can also be
  downloaded and read first.
- The Linux Trash path is covered by tests that patch the platform and by CI, and was not run by
  hand on Linux. The macOS move into `~/.Trash` was run once on a probe file.
