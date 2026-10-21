# ADR-0051: Catalogue folders, shared skills and the link script

- Status: Accepted
- Date: 2026-10-21
- Authority: operator asked for Tools to render every folder a contributor publishes, for the operator's skills to be installable from the site, and for the retired harness and hook sources to go.
- Partially supersedes: [ADR-0024](0024-tools-agents-playground.md), which published only `tools/` and kept `contributors/*/libraries/` as repository workflow source.

## Decision

A contributor folder is `contributors/<login>/<catalogue>/<item>/<files>`. Every
first-level folder is a catalogue: `tools` as before, `skills` and `scripts`, or
any other name. `contributors/default/` stays system-owned and publishes `tools`.

`/tools/<contributor>` shows one catalogue at a time. A switch between them
appears only when the contributor publishes more than one. The choice is stored
in `?catalogue=`, beside `?node=`, and an unknown value falls back to the first
catalogue (tools, skills, scripts, then A to Z). Each item folder is one card and
needs at least one Markdown file.

The build publishes sources under `/catalog/contributors/<owner>/<catalogue>/`,
an archive per item under `/catalog/collections/<owner>/<catalogue>/<item>.zip`,
and a bundle per catalogue at `/catalog/collections/<owner>/<catalogue>.zip`.
`/catalog/index.json` lists both. Archives keep repository-relative paths.

`contributors/*/libraries/` is removed: the Codex agents, harness, hooks,
templates and workflow skills it held are retired. Git history keeps them.

The operator publishes two catalogues under `contributors/synasapmob/`:

- `skills/`: `frontend-convention`, `operator-cli`, `mock-data`, and
  `rules/AGENTS.md`, the session-wide rules that cannot wait for a skill to match
  a task.
- `scripts/link-skills/`: `link.sh`, `unlink.sh` and their documentation.

`link.sh` downloads the skills bundle, or reads a folder given with `--from`, and
installs it into `~/.agents`: skills into `skills/`, the rules as `AGENTS.md`. It
then links `~/.claude` and `~/.codex` skills, and the rules file of Claude Code,
Codex and DSH, for the agents that exist on the machine. It only adds:

- a skill that already exists is moved to `~/.agents/.backups/` first, never into
  `skills/`, where an agent would load it twice;
- a rules file that already exists is kept, and the shipped one is saved beside it;
- a path that already exists is not replaced by a link;
- a symlinked `~/.agents/skills` stops the script, because copying through it
  would write into the folder it points at.

`unlink.sh` removes the links and moves what was installed to the backups.

Community pull requests keep ADR-0024's scope: Markdown in the author's own
`tools/<tool>/` folder. Other catalogues are maintained by the repository owner.

## Consequences

- Every published file is bundled into the frontend as text, so catalogue
  folders should hold text files of modest size. The vendored `scroll-world`
  skill (about 176 KB) is not published for this reason.
- Item ids are looked up by name for their card text and install instructions, so
  an item in another catalogue that reuses a tool's id (`gateway`, `omp`) would
  borrow that tool's sheet.
- `curl | bash` trusts the site's origin, as the existing installers do. The
  script reads no input and writes only under `~/.agents` and the agent links.
- The skills also live in the operator's own hub repository. Updating one copy
  does not update the other.
