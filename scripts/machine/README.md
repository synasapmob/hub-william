# machine

Installs personal agent tooling onto this Mac: skills, MCP servers, zsh
fragments and one always-on personal harness markdown. Claude, Codex and Grok
each get only what you selected for them.

There is exactly one harness source to maintain:
`system/contributors/default/libraries/harness/AGENTS.md`. `init`, `sync`, and `update` generate a read-only
copy under the filename each agent expects. They replace a previous global
harness at those exact home paths after moving it to a timestamped backup. They
never remove a repository's own `AGENTS.md` or `CLAUDE.md`; those project files
remain available for project-specific rules such as Linear routing.

The delivery templates are local too:
`contributors/synasapmob/templates/github-pull-request.md` and
`contributors/synasapmob/templates/linear-issue.md`. The first is vendored from dopamint-arena's
PR template; the second keeps only DOPAN-175's issue structure, never its
project-specific metadata. The harness reads these catalog copies at runtime,
so delivery does not depend on that repository path or the Linear example URL
remaining reachable.

The contract is [`docs/machine-harness-plan.md`](../docs/machine-harness-plan.md).
This file covers how to use it and the few places the plan left a choice open.
For a short list of the active tags, combinations, paths and tool rules, see
[`harness_guiline.md`](harness_guiline.md).

On a Mac that has none of this yet:

```sh
gh api -H "Accept: application/vnd.github.raw" \
  repos/Southern-Discoveries/hub-william/contents/machine/boot.sh | sh
```

After that it is one path, typed in full:

```sh
~/.hub-william/scripts/machine/install.sh init       # browse the catalog and pick
~/.hub-william/scripts/machine/install.sh update     # pull, then sync
~/.hub-william/scripts/machine/install.sh mcp auth   # log in to the OAuth servers
~/.hub-william/scripts/machine/install.sh status     # catalog, CLIs, profile, pending
```

There is deliberately no `hub-william` command to install first. A wrapper is
one more thing that has to be present and correct before you can fix anything,
and this is the tool you reach for when a machine is not set up yet.

Nothing here installs an agent CLI, opens a GUI, or authenticates `gh`.

## Where it lives

`boot.sh` clones into **`~/.hub-william`**, sparse and blobless, so only
`machine/` lands in the working tree — the rest of the app is not your
business on a machine you are setting up. About 900K, half of it history. The
repo is private, so `gh` does the authenticating; no token has to be in your
environment.

That one line is both install and update: it clones when there is nothing
there and pulls when there is, so you never have to know which. It runs `init`
unless you name something else:

```sh
gh api ... | sh -s -- sync
gh api ... | sh -s -- status
```

Which is why nothing here asks you to remember where the checkout is. It is
the editable source of truth for generated harness and skill outputs.

Everything the installer needs is in that one directory, next to the code:
`profiles/local.toml` is your answers, `state/applied.json` is what it created.
Both are gitignored, which is exactly why `update` can be a `git pull` — it
never touches them.

That also means **the checkout is a working copy**. A skill you write or a
group you move is a git change like any other, and `update` refuses to pull on
top of an uncommitted one rather than choosing for you. Commit it, or stash it.

Harness files and skill trees in agent homes are generated read-only copies;
zsh fragments remain symlinks into `~/.hub-william`. Moving or deleting the
checkout therefore breaks shell links, but a later `init` repairs them. A sync
also regenerates any managed harness or skill whose content or write mode
drifted. Edit the catalog, never the installed output.

Moving from an older checkout is the same, with one shortcut. Carry the two
gitignored files across first and the new install adopts what the old one
made, instead of rebuilding it:

```sh
old=~/Documents/personal/hub-william          # wherever it was
cp "$old"/machine/profiles/local.toml ~/.hub-william/scripts/machine/profiles/
cp "$old"/machine/state/applied.json  ~/.hub-william/scripts/machine/state/
~/.hub-william/scripts/machine/install.sh init
```

## `init`

A tree, walked with the arrow keys:

```
tools ─┬─ frontend-mcps ── playwright ── claude / codex / grok
       └─ alias ────────── terminal.zsh
```

| key | |
|---|---|
| **↑ ↓** | move (`k`/`j` too) |
| **→** | go deeper, where there is a deeper |
| **←** | come back — nothing to do at the top |
| **space** | on/off. On a group that means every item in it, for every agent |
| **a** / **n** | all or none, at whatever level you are |
| **enter** | `sync` — preview, confirm, apply |
| **q** | quit and keep nothing |

How far **→** goes depends on the row. An MCP server or a skill is chosen
agent by agent, so there is a level under it. A shell fragment is one switch
for the whole machine — a shell has no idea which agent started it — so there
is not, and the hint stops offering `→ agents`.

A box reads `[x]` when every agent has it, `[ ]` when none do, and `[~]` when
some do — pressing space on a `~` gives you the rest rather than taking away
the ones you have.

**The first run starts with every box ticked.** Nothing has been decided yet,
and an empty screen is a worse place to start than a full one. After that the
screen shows what you last saved, because that is what is installed:
`profiles/local.toml` is written when you accept, and read back next time.

Both `init` and `sync` print the plan and ask once before touching anything.
The plan lists what would **move** — the twenty things that would stay put are
not a decision, so they are not on it. The question takes one keypress: `y`,
`n`, or enter for the capitalised default. `--yes` skips it, and so does a
non-terminal stdin, which is what makes the whole thing scriptable.

## The three layers

| Layer | Where | Means |
|---|---|---|
| Catalog | `machine/registries/` | the package **has** this item |
| Profile | `machine/profiles/local.toml` | this agent **wants** or **refuses** it |
| Disk | `~/.claude`, `~/.codex`, `~/.grok`, `~/.zsh` | what is installed |

`sync` moves disk toward catalog ∩ profile. It installs what is allowed and
missing, uninstalls what it installed and is no longer allowed, and leaves
everything else alone. Managed harness and skill outputs are regenerated when
their bytes or read-only mode drift. The three global harness entrypoints are
the deliberate ownership exception: when enabled, an existing entrypoint is
backed up and replaced with the canonical generated personal harness.

## Groups

`catalog/groups.toml` is the only thing that decides what `init` shows and in
what order. It is data — nothing in `lib/` knows these names:

```toml
[frontend-mcps]
description = "drive a real browser, screenshot what changed"
mcp = ["playwright", "chrome-devtools"]

[alias]
description = "sb-*, dopa-tps, shell history"
shell = ["supabase-alias.zsh", "dopa-tps.zsh", "terminal.zsh"]
```

A group can mix `shell`, `mcp`, `skills` and `harness = true`. Adding
`[backend-skills]` later is an edit to this file, not to the installer.

Two things it will not let you hide. A name you list that is not in the
catalog yet still shows, marked, so you can write the group before the thing.
And anything in the catalog that **no** group claims is appended as `other` —
an item can never be installed by `sync` while being invisible in `init`. With
this file complete that row never appears; seeing it means you added something
to the catalog and have not filed it yet.

## What it will never do

- Delete anything that is not recorded in `state/applied.json`. A skill
  directory you wrote by hand, a symlink you made, an MCP block you edited, a
  fragment of yours in `~/.zsh`: reported, never touched. The only exception is
  a previous global harness at `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` or
  `~/.grok/AGENTS.md`: it is moved to a recoverable timestamped backup before
  the canonical generated copy replaces it.
- Touch any project-local `AGENTS.md`, `AGENTS.override.md` or `CLAUDE.md`.
- Rewrite `~/.claude.json`, `~/.codex/config.toml` or `~/.grok/config.toml`
  wholesale. MCP blocks are edited by line span; every other byte of those
  files is copied through.
- Overwrite `~/.zsh/secrets.zsh` once it exists.
- Lift a deny on its own.

`state/applied.json` is the record of everything it did create. Delete it and
the installer forgets most of what is his, and later removals become reported
skips instead of deletions. Generated harness headers, generated skill marker
files, and zsh symlinks into `machine/registries/` can prove ownership even after
state is lost, so a deny still uninstalls them.

`~/.claude.json` is Claude Code's live state file, not just config. The
installer reads it, changes the `mcpServers` key and writes it back atomically,
which is what the CLI itself does — but two writers still race. Run `sync`
with no Claude Code session open if you want to be sure.

## Allow, deny, undecided

`init` writes both lists, so a name you unticked is denied, not undecided.

| You run | Effect |
|---|---|
| `skill add B` | catalog stays; every agent that does not deny B allows it |
| `skill add B --agent codex` | **lifts** Codex's deny and allows B there |
| `skill remove B` | uninstalls everywhere, drops B from every allow, writes no deny |
| `skill remove B --agent codex` | uninstalls for Codex and writes Codex a deny |
| `mcp remove X` | as above, **and** deletes `catalog/mcp/X.toml` |

Two things in that table are decisions, not quotes from the plan:

**Naming an agent is what lifts a deny — including `--agent all`.** Typing an
agent's name is an explicit statement about that agent. Leaving `--agent` off
targets every agent on PATH and never overrides a refusal, which is what keeps
"unchecked at init survives a global remove and re-add" true. A global add that
every agent denies prints a warning telling you which flag would lift it,
rather than silently doing nothing.

**`mcp remove` drops the catalog file; `skill remove` keeps it.** `mcp add`
wrote that one-line TOML, so `mcp remove` takes it back — `--keep-catalog`
opts out. A skill is a directory you authored, so it survives unless you ask
for `--delete-catalog`.

**A name in neither list is undecided**, and `sync` reports it instead of
installing it. The plan's shorthand — "in catalog, not denied, install it" —
cannot coexist with a global remove that sticks, because a removed item would
reappear on the next sync. So removal drops the item from `*_allow`, and an
undecided item waits for you. `sync --adopt` allows every undecided item at
once when that is what you want.

## `--agent`

Comma-separated, no spaces: `claude`, `codex`, `grok`, or `all`.

| Form | Agents | Missing CLI |
|---|---|---|
| omitted | every one on PATH | skipped and reported |
| `--agent all` | all three | skipped and reported |
| `--agent grok` | exactly grok | **error**, non-zero exit |

## `mcp add`

The words after the name are the spawn command, verbatim. Flags for the
installer come first; use `--` when the command could be mistaken for one.

```sh
./install.sh mcp add playwright npx @playwright/mcp@latest
./install.sh mcp add playwright --agent claude -- npx -y @playwright/mcp
./install.sh mcp add linear --url https://mcp.linear.app/mcp
```

Adding never authenticates. `mcp auth` does that, one browser at a time, and
only for HTTP servers — a stdio server has nothing to log in to. Tokens land
in each harness's own store; there is no shared Linear login across the three.

## `mcp auth`

One server, one agent, one browser at a time. Under the hood it is the vendor's
own command — for Claude, `claude mcp login <name>` — so anything you can fix by
hand you can fix the same way here.

**Settle the URL before you log in.** A stored grant is tied to the URL it was
issued for, so adding `read_only=true` or editing `features` afterwards costs a
fresh login for every agent that had it. Decide the query string first.

**`Unrecognized client_id` is a stale registration, not the wrong account.**
These servers use dynamic client registration: the agent registers itself once,
keeps the `client_id` and reuses it. When the server stops honouring that id the
login fails before any account is ever chosen, so re-running it changes nothing.
Clear the grant and let the next login register again:

```sh
claude mcp logout <name>
claude mcp login  <name>
```

**Two entries on one host may share one OAuth resource.** Supabase advertises
`"resource": "https://mcp.supabase.com/mcp"` with no query string, so entries
that differ only by `project_ref` look like one resource to the authorization
server. They do hold two accounts at once — that is tested and works — but
finish one login before starting the next, and sign out of the provider in the
browser in between or the second flow silently reuses the first account.

**A wiped checkout forgets what it owns.** `state/applied.json` lives inside
`~/.hub-william`, so deleting that directory loses every ownership record.
`sync` then reports installed blocks as `already configured, not by us` and
leaves them alone — correct, but it means a changed catalog URL never lands.
`sync --force-mcp` is the way back.

## Secrets

`~/.zsh` is a real directory holding one symlink per fragment you ticked, each
pointing into `catalog/zsh/`. That is what makes a single fragment declinable;
a whole-directory link, which is what earlier versions installed, shipped all
of them or none. `sync` converts one when it finds it.

Your own `~/.zsh` is not moved aside. Our links go in beside your files, and a
name collision is reported rather than resolved — your file wins.

`catalog/zsh/secrets.zsh.example` lists empty exports. On the first install a
copy lands at **`~/.zsh/secrets.zsh`**, mode 600, and is never overwritten
afterwards. It is the one file here that cannot be re-created, so it lives in
your home rather than inside the repo; a copy left in `catalog/zsh/` from an
older install is moved out on the next `sync`. The fragments read those
variables at call time, so a blank value degrades one command instead of
breaking your shell.

Turning every fragment off removes the links and the `~/.zshrc` block, but
leaves `~/.zsh` behind if `secrets.zsh` is still in it.

`~/.zshrc` keeps one marked block. Existing `source ~/.zsh/*.zsh` lines are
commented out with a marker so nothing is sourced twice, and a `source` of a
Claude scratchpad `deno/env` is dropped — those paths live under `/private/tmp`
and vanish, leaving a broken login shell. Turning the fragments off reverses
all of it.

## Adding to the catalog

- **Skill**: write `system/contributors/default/libraries/skills/<name>/SKILL.md`, then `./install.sh skill add <name>`.
- **MCP**: `./install.sh mcp add <name> ...` writes `catalog/mcp/<name>.toml`.
- **Shell fragment**: drop a `.zsh` file in `catalog/zsh/`.
- **Plugin**: hand-write `catalog/plugins/<name>.toml`; see the README there.
  `sync` shells out to the vendor CLI, best effort — a failure is reported and
  does not roll back the skills and MCP servers that already applied.

Then name it in `catalog/groups.toml` so it lands where you expect in `init`.
Skip that and it still shows, under `other`.

## Layout

```text
machine/
  boot.sh                 clone into ~/.hub-william, then run install.sh
  install.sh              finds a python3, hands over to lib/cli.py
  lib/                    stdlib only, python 3.8+ (macOS ships 3.9)
    tomlfile.py           parse to compare, edit by line span to write
    sync.py               the delta: plan() is pure, apply() runs it
    browse.py             the three levels; keys.py is the raw input under it
    agents/               one adapter per harness
  catalog/                the package's source of truth
    groups.toml           what init shows, and in what order
  profiles/local.toml     this machine's answers. Gitignored.
  state/applied.json      what this installer created. Gitignored.
  tests/
```

`lib/` carries its own TOML reader because `tomllib` landed in python 3.11 and
the system python on macOS is 3.9. It parses only to compare what is already
configured; writes are line-span edits, so a user's formatting survives.

## Tests

```sh
./tests/run.sh            # every python3 on the machine, oldest first
```

Every test gets its own `HOME`, its own `PATH` of fake agent CLIs, and its own
copy of `machine/`, and drives the real `install.sh`. The seven cases named in
the plan are marked with `Plan test N` in `tests/test_machine.py`. The
interactive screens are driven through a pty in `tests/test_tui.py`.
