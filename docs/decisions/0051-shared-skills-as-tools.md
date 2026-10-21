# ADR-0051: Shared skills as tools and the link script

- Status: Accepted
- Date: 2026-10-21
- Authority: operator asked for their skills to be installable from the site as plain cards on their `/tools/synasapmob` page, and for the retired harness and hook sources to go.
- Partially supersedes: [ADR-0024](0024-tools-agents-playground.md), which kept `contributors/*/libraries/` as repository workflow source.

## Decision

`contributors/*/libraries/` is removed: the Codex agents, harness, hooks,
templates and workflow skills it held are retired. Git history keeps them.

The operator publishes two tools under `contributors/synasapmob/tools/`. They are
ordinary tools: no new folder level, tab or filter, and they appear at
`/tools/synasapmob` like any contributed tool.

- `skills/` (card SKILLS): `frontend-convention`, `operator-cli`, `mock-data` and
  `rules/AGENTS.md`, the session-wide rules that cannot wait for a skill to match
  a task. One card, one zip. To use them, download the zip.
- `link-skills/` (card LINK SKILLS): `link.sh`, `unlink.sh` and their documentation.

A tool folder may hold files other than Markdown. The catalogue already published
them; it now takes a script's title and description from its leading comment and
skips a Markdown file's front matter. nginx serves catalogue scripts as text so
the path link opens instead of downloading.

`link.sh` downloads `/catalog/collections/synasapmob/tools/skills.zip`, or reads a
folder given with `--from`, and installs it into `~/.agents`: skills into
`skills/`, the rules as `AGENTS.md`. It then links `~/.claude` and `~/.codex`
skills, and the rules file of Claude Code, Codex and DSH, for the agents that exist
on the machine. It only adds:

- a skill that already exists is moved to `~/.agents/.backups/` first, never into
  `skills/`, where an agent would load it twice;
- a rules file that already exists is kept, and the shipped one is saved beside it;
- a path that already exists is not replaced by a link;
- a symlinked `~/.agents/skills` stops the script, because copying through it
  would write into the folder it points at.

`unlink.sh` removes the links and moves what was installed to the backups.

Community pull requests keep ADR-0024's scope: Markdown in the author's own
`tools/<tool>/` folder. Scripts are published by the repository owner.

## Consequences

- Every published file is bundled into the frontend as text, so tool folders
  should hold text files of modest size. The vendored `scroll-world` skill (about
  176 KB) is not published for this reason.
- Install instructions and card text are keyed by tool id, so a tool that reuses
  `skills` or `link-skills` under another contributor would borrow their sheets.
- `curl | bash` trusts the site's origin, as the existing installers do. The
  script reads no input and writes only under `~/.agents` and the agent links.
- The skills also live in the operator's own hub repository. Updating one copy
  does not update the other.
