# Architecture

Hub William is a static site over a folder of Markdown. That sentence is the
architecture; everything below is a consequence of it.

## The shape

```text
contributors/**/*.md   the catalogue — contracts, skills, templates
        │
        │  import.meta.glob(..., { query: "?raw", eager: true })
        ▼
src/services/catalog      parses front matter, derives category and area
        │
        ▼
src/routes/_app.library…  draws it as a canvas
        │
        │  react-router prerender
        ▼
build/client/**/*.html    real HTML per route, served by anything
```

There is no server, no database, no account and no request. The catalogue is
inlined into the bundle at build time, so what the site publishes is exactly
what the repository contains at the commit it was built from.

## Why there is no backend

The thing this site publishes is already a set of files under version control,
reviewed by pull request. A database in front of that would add a second source
of truth, a way for the two to disagree, and an account system to protect
writes that a pull request already gates.

The consequences are worth naming, because each one is something the code now
relies on:

- **Every route prerenders.** Nothing is fetched, so there is nothing to wait
  for, so each route can be written to HTML at build time. That is what makes
  the pages readable by a crawler rather than only by a browser running React.
- **The CSP can be strict.** `connect-src 'self'` is absolute rather than a
  list, because the app opens no connection at all.
- **A contribution is a diff.** Adding an entry is adding a file; removing one
  is removing a file. There is no migration, no seed, and no admin screen.
- **Freshness is a deploy.** The catalogue changes when `main` changes. If that
  ever becomes too slow, the answer is a build hook, not a database.
- **No route is behind an account.** There is nothing to protect: a public
  specification, a public catalogue, and telemetry that is still fixture data.
  Adding a login means adding a backend, which is a change to what this is.

`/activities`, and the sidebar's recent-updates list, are fixture data behind
`utils.activities.ts` and the `_app/` route folder respectively. They are shaped
like the real thing so that the day either becomes rows, only the service
changes.

## The catalogue

`src/services/catalog` is the only module that knows the folder exists. It
reads every `.md` under `contributors/default/` and decides three things about each:

| Fact        | Where it comes from                                             |
| ----------- | --------------------------------------------------------------- |
| Category    | The top folder — `harness/`, `skills/`, `templates/`            |
| Group       | The folder below it — `harness/tags/` is the group named "Tags" |
| Contributor | `contrib/<login>/…`, or none for the shared catalogue           |

Both levels are folders on purpose. Renaming `harness/tags/` to
`harness/labels/` renames the heading on the canvas and nothing else, and a
folder nobody has seen still groups and still draws.

Colour comes from the category and stops there. A group inherits the hue of the
root it sits under, so a folder arriving by pull request joins the tree it
landed in instead of claiming a colour of its own — see `src/utils/utils.tone.ts`.
A category nobody has given a hue draws neutral, which is a state a reviewer can
promote rather than a colour nobody chose.

Name and description come from the document's first heading and first
paragraph. Front matter is honoured only where the format already has it — a
skill carries `name` and `description` because Claude Code requires them.

**The service never edits its sources.** Those files are instructions an agent
reads at runtime; adding a field to make a listing page tidier would be editing
an instruction to suit a page. Everything the canvas needs is derived instead.

### Shared and contributed

A contract that maps one person's repositories to one person's servers is
theirs, not everyone's. Those live under `contributors/<login>/`,
mirroring the shared layout one level down, and are published at
`/library/<login>` rather than in the shared catalogue. `/library` shows only
entries without a contributor, which is what keeps it worth reading.

The folder name is the contributor's GitHub login. That convention is load
bearing: it is what makes `https://github.com/<login>.png` their avatar without
an API call, a token or a stored file.

## The canvas

`/library` is one artboard with a fixed layout, not a graph engine:

- The category roots sit in one row, and one tree is open at a time. Two fans
  of branches over the same rows leave a reader unable to tell which trunk a
  card hangs from.
- Inside an open tree, one headed block per folder, wrapping onto as many rows
  as it needs. The heading sits astride the spine and is opaque, so the trunk
  reads as running into the group rather than past its label.
- Pan, and zoom about the pointer. With `transform-origin: 0 0` a screen point
  is `pan + point × zoom`, so scaling without re-solving for pan drags
  everything toward the artboard's corner. `library-canvas-geometry.ts` holds
  every position in canvas units and nothing else does.

Which tree is open and which document is being read live in the query string,
so a canvas position can be linked, bookmarked and walked back through.

## Rendering a document

Contributed Markdown is authored by strangers, so `src/components/markdown/` is
the only supported way to render one, over a narrowed `rehype-sanitize` schema.
Templates skip it: a pull-request template is mostly `<!-- instructions -->`
that a Markdown renderer drops on sight, so it is shown verbatim as a copyable
snippet. The rules that keep this safe are in
[frontend-conventions.md](./frontend-conventions.md).

## The machine installer

`scripts/machine/` is a separate program that lives in the same repository: it installs
the catalogue onto a developer's machine as agent instructions. The site
publishes those files; the installer puts them where an agent reads them. They
share the folder and nothing else — no import crosses between them.

Its own suite (`bash scripts/machine/tests/run.sh`) pins the catalogue's layout on
purpose, and runs in CI for that reason. A contract that moves without its
references breaks the harness rather than the site, and nothing else would
catch it.

## Deployment

GitHub Actions builds and publishes to one `gh-pages` branch: `main` to the
site root, `dev` to a `dev/` subfolder. `VITE_BASE_PATH` threads the same prefix
through Vite's `base` and React Router's `basename`, because a project site is
served from `/<repository>/` rather than the domain root.

`main` is protected: no direct pushes, and a branch must be up to date with a
green `checks` run before it merges.
