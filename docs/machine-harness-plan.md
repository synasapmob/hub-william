# Machine harness: agent skills, MCP, and shell

A Hub William package that installs (and later uninstalls) personal agent
tooling onto this Mac: skills, MCP servers, zsh fragments, and a short always-on
harness markdown. Claude, Codex, and Grok each get only what the operator
selected. A later dashboard page lists the catalog and downloads the installer.

This file is the implementation contract. Code it against these rules; do not
relitigate them in the script.

## Goals

1. One repo-local installer: `machine/install.sh`.
2. `init` is a terminal TUI with a Hub William banner (Claude-Code-like).
3. `sync` is a delta: install catalog adds, uninstall catalog deletes, never
   force an agent to take something it denied.
4. Sticky per-agent allow/deny. Unchecked at init stays denied after a global
   remove + re-add.
5. `mcp auth` logs in only OAuth MCPs, only agents whose CLI is on PATH,
   step-by-step. Missing CLI is a skip unless `--agent` named that CLI.
6. Do not dump `~/.claude.json` / `~/.codex/config.toml` / `~/.grok/config.toml`.
   Merge snippets. Never overwrite existing env keys or user-owned files.
7. Secrets stay out of git (`secrets.zsh`, OAuth tokens, API keys).

## Non-goals (v1)

- Do not auto-install the Claude / Codex / Grok CLIs.
- Do not open a macOS/web GUI. TUI only.
- Do not ship the dashboard Tools page in v1 (phase 6).
- Do not `npm uninstall` Playwright when removing the MCP block.
- Do not auth during `mcp add` or `sync`.
- Do not copy telemetry headers, Hub William gateway keys, or Supabase tokens
  into catalog files.

## Layout

All of this lives in **this** repository, not dopamint-arena:

```text
hub-william/
  machine/                         # the package
    install.sh                     # thin CLI wrapper
    lib/                           # Python 3 stdlib: parse, merge, probe
    catalog/
      harness/AGENTS.md            # one canonical personal workflow harness
      templates/                   # local Linear and GitHub delivery templates
      skills/<name>/SKILL.md
      mcp/<name>.toml              # url or command+args; no tokens
      plugins/<name>.toml
      zsh/                         # grok.zsh, supabase-alias.zsh, terminal.zsh
        secrets.zsh.example
      shell/zshrc
    profiles/
      default.toml                 # committed suggestions
      local.toml                   # gitignore; this machine's allow/deny
    state/
      applied.json                 # gitignore; what this installer created
    tests/
  docs/machine-harness-plan.md     # this file
  public/machine/                  # phase 6: files the dashboard can download
```

Home is runtime; the repo is source. Harness files and skills are generated as
read-only copies, while zsh fragments are symlinks into `machine/`. Every sync
repairs generated output drift from the catalog, so source is still edited in
one place only. Project-local harness files are not copied, deleted or hidden.

## Banner (`init` and `sync`)

Match Claude Code's three-line wordmark + metadata, Hub William branded:

```text
 ▐▛███▜▌   Hub William
▝▜█████▛▘  machine setup
  ▘▘ ▝▝    ~/Documents/personal/hub-william
```

Left column is the same block-quad glyph as Claude Code. Right column is
product, command, cwd. Print it once at the top of `init`, `sync`, and `mcp
auth`. Do not animate. Do not depend on a font beyond the terminal's Unicode
block elements (U+2590, U+2584, U+2580, U+259E family as in Claude's mark).

`./install.sh` with no args prints the banner plus help, then exits 0.

## CLI

```text
./install.sh
./install.sh init
./install.sh sync
./install.sh status

./install.sh skill add    <name> [--agent claude|codex|grok|all]
./install.sh skill remove <name> [--agent ...]

./install.sh mcp add    <name> <command...>
./install.sh mcp add    <name> --url <url>
./install.sh mcp remove <name> [--agent ...]
./install.sh mcp auth
./install.sh mcp auth   <name> [--agent ...]
```

`--agent` is a comma-list, no spaces: `claude`, `codex`, `grok`, or `all`.
Default when omitted: every agent **on PATH**. `--agent grok` when `grok` is
missing is an error. Default (no flag) missing Grok is a skip + report.

`add` / `remove` already sync. `sync` is for a hand-edited `local.toml` or a
new CLI that appeared on PATH.

Remainder after `mcp add <name>` is the spawn argv. Flags for install.sh that
must follow the command use `--`:

```text
./install.sh mcp add playwright npx @playwright/mcp@latest
./install.sh mcp add playwright --agent claude -- npx -y @playwright/mcp
./install.sh mcp add linear --url https://mcp.linear.app/mcp
```

## Three layers

| Layer | Where | Meaning |
|---|---|---|
| Catalog | `machine/catalog/` | The package *has* this item |
| Allow / deny | `profiles/local.toml` | This agent *wants* / *refuses* it |
| Disk | `~/.claude`, `~/.codex`, `~/.grok`, `~/.zsh` | What is installed |

`init` writes **both** allow and deny. Unchecked is deny, not "undecided".

```toml
[claude]
skills_allow = ["A", "B"]
skills_deny  = ["C"]
mcp_allow    = ["linear", "playwright"]
mcp_deny     = []
harness      = true

[codex]
skills_allow = ["A"]
skills_deny  = ["B"]
mcp_allow    = ["linear"]
mcp_deny     = ["playwright"]
harness      = true
```

Grok scans `~/.claude/skills` by default. If the Grok profile differs from
Claude, skills go only to `~/.grok/skills/` and `compat.claude.skills` is set
false so Claude's extra skills do not leak.

## `sync` is a delta

Each run:

1. Item in catalog, agent does **not** deny → install if missing.
2. Item removed from catalog → uninstall installer-owned copies.
3. Agent **deny** → never install, even if the catalog re-adds the name.
4. Existing env keys, user-owned skill dirs, and MCP blocks the user edited →
   do not touch.

Worked case:

```text
init                         Codex unchecks playwright → mcp_deny
mcp remove playwright        catalog gone; Claude uninstalled
mcp add playwright npx ...   catalog back
sync
  claude  allow → install again
  codex   deny  → skip
```

Lift a deny only with an agent-scoped add:

```text
./install.sh mcp add playwright --agent codex
```

Global `skill add B` (no `--agent`): B enters the catalog; agents that do not
deny B get it; Codex already denying B stays skipped.

Global `skill remove B`: catalog file stays unless `--delete-catalog`; every
agent unlinks installer-owned `B`. Deny keys remain, so a later global add
still skips Codex.

## What each `add` actually does

Same verb, different adapter:

| Kind | Behind the scenes |
|---|---|
| skill | Generate a read-only copy of `catalog/skills/<name>` under each selected agent's skills directory. No npx. |
| mcp stdio | Write `catalog/mcp/<name>.toml`, merge `command`/`args` into each agent's config. The agent spawns `npx` later. |
| mcp HTTP | Write `url` only. OAuth is `mcp auth`, not add. |
| zsh | Symlink `~/.zsh` → `catalog/zsh`. Copy `secrets.zsh.example` → `secrets.zsh` only if missing. Never overwrite `secrets.zsh`. |
| harness | Back up/replace each global harness entrypoint, then generate a read-only copy of the canonical `AGENTS.md` at `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.grok/AGENTS.md`. Project harnesses remain untouched. |
| plugin | Vendor CLI (`claude plugin …`). Failure does not roll back skills/MCP. |

Merge rules:

- Skills: missing → generated copy; managed output drift → regenerate; foreign
  file/directory/symlink → skip + warn.
- MCP: missing name → insert block; existing same url/command → no-op;
  existing different → keep unless `--force-mcp`.
- env: add-if-absent only.
- permissions allow-lists: union, never shrink.
- `state/applied.json` records every path/block this installer created. Remove
  only those.

Do not append blindly to JSON/TOML. Parse, merge, write atomically.

## `mcp auth`

Auth is not `mcp add`. Detect which catalog MCPs are OAuth (have `url`, no
stdio `command`). Skip Playwright.

```text
./install.sh mcp auth                      # every OAuth MCP × every CLI on PATH
./install.sh mcp auth linear               # Linear × every CLI on PATH
./install.sh mcp auth linear --agent claude
```

Step-by-step, one browser at a time, wait for Enter. Already-valid token →
skip that pair.

| Agent | How to login |
|---|---|
| Codex | `codex mcp login <name>` when the CLI supports it |
| Claude | Print: open `claude`, run `/mcp`, authenticate `<name>` |
| Grok | Print: `/mcps`, select server, press `i` |

Tokens stay in each harness store (`~/.grok/mcp_credentials.json`, Codex
keychain, Claude's own). There is no shared Linear login across the three.

`gh auth login` is out of band. The harness markdown requires `gh`; the
installer does not run it.

## `init` TUI

Bare `./install.sh` is help. `init` is the tutorial.

1. Banner.
2. Probe `claude`, `codex`, `grok`, `gh`. Missing CLIs listed, not fatal.
3. One screen per agent on PATH: checkboxes for catalog skills and MCPs
   (prefill `local.toml` or `default.toml`). Uncheck writes deny.
4. Shared zsh / harness toggles.
5. Preview: add / keep / remove / skip-deny / skip-user-owned / skip-missing-cli.
6. Confirm → sync → write `local.toml` + `state/applied.json`.
7. Remind `mcp auth` for OAuth servers just added.

Later `init` opens on "edit selection / sync now / status / quit" when
`local.toml` exists.

Use `gum` when installed; otherwise stdin prompts. No extra GUI toolkit.

## Always-on harness markdown

`catalog/harness/AGENTS.md` is the single mandatory personal workflow source.
It defines the composable `[answer]`, `[plan]`, `[delivery]`, `[local]`, `[ete]`,
`[worktree]`, `[ignore]`, `[linear]`, `[linear-<ISSUE-ID>]`, `[auto]`,
`[rebase]`, `[draft]`, `[mergeable]`, `[merge]`, `[playwright]`, and
`[dopa-tps]` tags; fixed worktree and screenshot roots; honest verification rules; local Linear/PR
template paths; and MCP, GitHub and Supabase routing. The
templates live in `catalog/templates/`, so runtime delivery does not depend on
another checkout or on DOPAN-175 staying available.

JSON/TOML of the agents is MCP registration only. It does not point at this
markdown. The markdown is loaded through the three generated home-level files. A
project's own harness is still read normally and supplies its local context. An
explicit tag controls the workflow side effects for that turn; without a tag,
the project's normal workflow applies.

## Secrets

`catalog/zsh/secrets.zsh.example` lists empty exports (`HUB_WILLIAM_KEY`,
Supabase PATs, optional `LINEAR_API_KEY`). Real `secrets.zsh` is gitignored.

Sanitize today's `~/.zsh/grok.zsh` and `supabase-alias.zsh` so they read
those variables instead of hardcoded keys. Do not commit the current values.

`.gitignore` at repo root (or `machine/.gitignore`):

```text
machine/profiles/local.toml
machine/state/applied.json
machine/catalog/zsh/secrets.zsh
```

## Implementation phases

**P0 — skeleton.** `machine/install.sh` help + banner. `lib/` probe +
`status`. Catalog stub + `harness/AGENTS.md`. Tests with `HOME` in tmp.

**P1 — skills + deny.** `init` (stdin), `skill add/remove`, `sync` generated
reconcile, lockfile. Tests: add C all; rm B all; Codex deny B survives
global re-add; user-owned dir not deleted; missing Codex CLI still updates
Claude.

**P2 — MCP merge.** `mcp add/remove` for stdio and `--url`. Merge into
`~/.claude.json` user-scope, `~/.codex/config.toml`, `~/.grok/config.toml`.
Existing Linear url is not overwritten. Deny sticky same as skills.

**P3 — zsh.** Symlink `~/.zsh`, backup a real directory once, never replace
`secrets.zsh`. Drop the accidental `~/.zshrc` line that sources a Claude
scratchpad `deno/env`.

**P4 — TUI.** Banner + checkbox screens. `gum` optional.

**P5 — `mcp auth`.** Probe, OAuth-only, step-by-step, skip missing CLI.

**P6 — dashboard Tools page (later).** New workspace nav item `/tools`. List
catalog skills and MCPs as cards. Primary action downloads
`public/machine/install.sh` (and optionally a zip of `machine/`). The
downloaded script is the same entrypoint as the repo file, or a one-liner
that clones this repo and runs `machine/install.sh init`. No apply-from-browser:
the browser never writes `~/.claude`. This phase is UI + an artifact in
`public/`; it does not change merge rules.

## Tests (do not skip)

Temp `HOME`:

1. `sync` twice → second run no-op.
2. User file at `~/.claude/skills/B` (not our generated tree) → `skill remove B`
   does not delete it.
3. Codex absent from PATH → Claude still receives a new skill.
4. Codex `mcp_deny = ["playwright"]` → global remove + add playwright →
   Claude installs, Codex does not.
5. MCP block whose `env` the user changed → profile drop does not delete it.
6. `mcp auth linear --agent grok` with no `grok` → non-zero exit.
7. `mcp auth` with no Grok → skip, exit 0.

## Daily use

```text
# new machine (Claude installed, Grok/Codex not yet)
cd ~/Documents/personal/hub-william/machine
./install.sh init
./install.sh mcp auth linear

# later
./install.sh skill add C
./install.sh mcp add playwright npx @playwright/mcp@latest
./install.sh skill remove B --agent codex
./install.sh sync --agent grok          # after installing Grok
```
