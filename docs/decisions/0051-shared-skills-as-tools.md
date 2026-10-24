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

- `skills/` (card SKILLS): `frontend-convention`, `operator-cli`, `mock-data`,
  the vendored MIT-licensed `scroll-world` (with its `LICENSE` and provenance
  README), and `rules/AGENTS.md`, the session-wide rules that cannot wait for a
  skill to match a task. One card, one zip. To use them, download the zip.
- `link-skills/` (card LINK SKILLS): `link.sh` and `unlink.sh`, nothing else. Its
  instructions are shown in the card's sheet, not in a Markdown file.

A tool folder may hold files other than Markdown, and no longer needs a Markdown
file to appear as a card. The catalogue already published such files; it now takes
a script's title and description from its leading comment and skips a Markdown
file's front matter. nginx serves catalogue scripts as text so the path link opens
instead of downloading.

`link.sh` runs in one of two ways. Without `--path` it fetches
`/catalog/collections/synasapmob/tools/skills.zip` from Hub William, so the reader
must trust the site; `curl -fsSL .../link.sh | bash` is that case. With
`--path=<zip or folder>` it reads the Skills zip the user downloaded, or the folder
they unzipped it into, and fetches nothing. It installs into `~/.agents`: skills
into `skills/`, the rules as `AGENTS.md`. It then links only the agents that do
not read `~/.agents` themselves, found by running each one against a home that held
nothing else (the table in `link.sh` records the result): Claude Code gets skill
links and `~/.claude/CLAUDE.md`; Codex reads `~/.agents/skills` but needs
`~/.codex/AGENTS.md`; agy keeps its global skills and rules under `~/.gemini`, so it
gets links in `~/.gemini/config/skills` and `~/.gemini/AGENTS.md`. DSH reads both
from `~/.agents`, and OpenCode reads the skills. It never deletes the user's work:

- a skill that already exists is moved to `~/.agents/.backups/` first, never into
  `skills/`, where an agent would load it twice;
- a rules file that already exists is kept and the shipped one is saved beside it,
  unless it is still an unedited copy of an earlier install. Then it is moved to
  the backups and the shipped one replaces it, so running `link.sh` again is enough
  to update the rules. "Unedited" means its sha256 equals the one `link.sh` recorded
  in `~/.agents/.hub-william-rules` when it installed that copy, or equals the copy
  that shipped before the record existed. Without a sha256 tool the file is kept;
- a path that already exists is not replaced by a link;
- a symlinked `~/.agents/skills` stops the script, because copying through it
  would write into the folder it points at.

`unlink.sh` removes the links and moves what was installed to the backups.

Community pull requests keep ADR-0024's scope: Markdown in the author's own
`tools/<tool>/` folder. Scripts are published by the repository owner.

## Consequences

- Every published file is bundled into the frontend as text, so tool folders
  should hold text files of modest size. `scroll-world` alone adds about 147 KB of
  source to the catalogue chunk.
- Catalogue files are served as they are, so `scroll-world/references/index.html`
  is a live page on the site's origin. It is the operator's own file; keep it that
  way, and do not publish HTML or scripts from anyone else under this origin.
- Install instructions and card text are keyed by tool id, so a tool that reuses
  `skills` or `link-skills` under another contributor would borrow their sheets.
- `curl | bash` trusts the site's origin, as the existing installers do. The
  script reads no input and writes only under `~/.agents` and the agent links.
- The skills also live in the operator's own hub repository. Updating one copy
  does not update the other.
