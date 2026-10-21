# Link skills

Install the Hub William skills into ~/.agents, the shared folder for agent skills and rules, with one command or by hand.

## One command

```sh
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/scripts/link-skills/link.sh | bash
```

`link.sh` downloads the Hub skills zip, copies each skill into `~/.agents/skills/<name>` and saves the shared rules as `~/.agents/AGENTS.md`. It then links the agents it finds on your machine (`~/.claude`, `~/.codex`, `~/.dsh`) to those copies.

It only adds. A skill you already have is moved to `~/.agents/.backups/` first, a rules file you already have is left alone (the Hub William rules are saved beside it as `AGENTS.hub-william.md`), and a link that already exists is not replaced. If `~/.agents/skills` is a symlink the script stops, because copying through it would write into the folder it points at.

## By hand

1. Download the Hub skills zip: `https://hub-william.site/catalog/collections/synasapmob/skills/hub-skills.zip`, then unzip it.
2. Copy each skill folder from `contributors/synasapmob/skills/hub-skills/` into `~/.agents/skills/`.
3. Copy `rules/AGENTS.md` to `~/.agents/AGENTS.md`.

Or unzip the bundle and let the script do the copying and linking:

```sh
bash link.sh --from contributors/synasapmob/skills/hub-skills
```

## Undo

```sh
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/scripts/link-skills/unlink.sh | bash
```

`unlink.sh` removes the agent links, moves the installed skills to `~/.agents/.backups/` and leaves `~/.agents/AGENTS.md` where it is.
