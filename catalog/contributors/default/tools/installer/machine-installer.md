# Machine installer

The program that puts this catalogue where an agent will actually read it. Its
public Python bootstrap maintains a sparse checkout and then hands control to
the installer in `apps/frontend/scripts/machine/`.

## What you need

- `python3` 3.8 or newer on `PATH`. macOS and most Linux distributions ship
  one; `install.sh` finds it and exits with a clear message if it cannot.
- At least one agent CLI on `PATH`: `claude`, `codex` or `grok`. With none of
  them installed the installer stops at `no agent CLI on PATH`.
- `git` and network access to the public repository.

## Install

```bash
curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 -
```

`init` draws the catalogue as a picker — arrow keys move, space toggles, enter
applies — and then shows you the plan before it writes anything. Nothing lands
on disk until you accept it.

## Where things land

| What | Where |
| --- | --- |
| Claude's always-on instructions | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Grok | `~/.grok/AGENTS.md` |
| Skills | `~/.claude/skills/<name>/` |
| MCP servers | `~/.claude.json`, `~/.codex/config.toml`, `~/.grok/config.toml` |
| What was installed | `~/.hub-william/apps/frontend/scripts/machine/state/applied.json` |
| What you picked | `~/.hub-william/apps/frontend/scripts/machine/profiles/local.toml` |

Installed documents are read-only copies carrying a
`hub-william-generated` header, not symlinks into the catalogue. Opening
`~/.codex/AGENTS.md` in an editor therefore cannot edit the catalogue by
accident. To change a contract, change it in the checkout and run
`~/.hub-william/apps/frontend/scripts/machine/install.sh sync` — each sync repairs whatever
has drifted.

## Install into one project

```bash
curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 - --path "$PWD"
```

The project copy lives below `.agents/rules/hub-william`. Existing `AGENTS.md`
and `CLAUDE.md` content is preserved around one replaceable managed block.

## Changing your mind

```bash
./install.sh sync      # re-apply: adds what you ticked, removes what you did not
./install.sh status    # what is installed, what is pending
./install.sh update    # git pull, then sync
```

`applied.json` is the ownership record, so a removal takes exactly what the
installer put there and nothing else. A symlink you made, a config block you
edited by hand, and a real `secrets.zsh` are left alone.
