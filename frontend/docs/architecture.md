# Architecture

Hub William is a monorepo with a static catalogue frontend and a Rust backend
boundary. The frontend is the production surface today; the backend bootstrap
currently exposes health and OpenAPI documentation only. Agent pools, payment,
database, Telegram, and gateway behavior remain follow-up work.

## The shape

```text
contributors/**/*.md       the catalogue — contracts, skills, templates
        │
        │  import.meta.glob(..., { query: "?raw", eager: true })
        ▼
frontend/src/services/catalog  parses front matter, derives collections
        │
        ▼
frontend/src/routes/…          renders functional collection nodes
        │
        │  react-router prerender
        ▼
frontend/build/client/**/*.html  real HTML per route

backend/src                     Axum health and generated OpenAPI boundary
```

There is no production database or account system yet, and nothing is fetched
to draw the current frontend. The catalogue is inlined into the bundle at build
time, so what the site publishes is exactly what the repository contains at the
commit it was built from. The build also writes that catalogue out as files — `/catalog/<path>`,
`/catalog/<folder>.zip`, `/catalog/collections/<owner>/<section>/<name>.zip`
and `/catalog/index.json` — which is what a download button and a `curl` command
both fetch, and the only traffic the site has.

## Why the catalogue remains static

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
  list, because the app opens no connection at all. Downloading an archive is a
  navigation to the site's own origin, which that directive does not govern.
- **A contribution is a diff.** Adding an entry is adding a file; removing one
  is removing a file. There is no migration, no seed, and no admin screen.
- **Freshness is a deploy.** The catalogue changes when `main` changes. If that
  ever becomes too slow, the answer is a build hook, not a database.
- **No route is behind an account.** There is nothing to protect in the current
  public specification, catalogue, and fixture telemetry. Account-bound
  behavior will deliberately cross the new backend boundary when it exists.

`/activities`, and the sidebar's recent-updates list, are fixture data behind
`frontend/src/utils/utils.activities.ts` and the `_app/` route folder respectively. They are shaped
like the real thing so that the day either becomes rows, only the service
changes.

## The catalogue

`frontend/src/services/catalog` is the only module that knows the folder exists. It
reads every `.md` under `contributors/default/` and decides three things about each:

| Fact        | Where it comes from                                             |
| ----------- | --------------------------------------------------------------- |
| Category    | The top folder — `harness/`, `skills/`, `templates/`            |
| Group       | The folder below it — `harness/tags/` is the group named "Tags" |
| Contributor | `contributors/<login>/…`, or none for the shared catalogue      |

Both levels remain folders because those paths are runtime contracts. The view
adds a separate functional taxonomy: most documents inherit their collection
from the folder, while an explicit semantic rule can group a cross-cutting file
where a reader expects to use it. `draft.md`, `merge.md`, `mergeable.md` and
`rebase.md` stay under `harness/tags/` but appear beside the supporting GitHub
documents in the one `GITHUB` node. Every file belongs to exactly one collection.

Name and description come from the document's first heading and first
paragraph. Front matter is honoured only where the format already has it — a
skill carries `name` and `description` because Claude Code requires them.

**The service never edits its sources.** Those files are instructions an agent
reads at runtime; adding a field to make a listing page tidier would be editing
an instruction to suit a page. Everything the collection view needs is derived
instead.

### Shared and contributed

A contract that maps one person's repositories to one person's servers is
theirs, not everyone's. Those live under `contributors/<login>/`,
mirroring the shared layout one level down, and are published at
`/library/<login>` rather than in the shared catalogue. `/library` shows only
entries without a contributor, which is what keeps it worth reading.

The folder name is the contributor's GitHub login. That convention is load
bearing: it is what makes `https://github.com/<login>.png` their avatar without
an API call, a token or a stored file.

## The collection view

`/library` and `/tools` are responsive flat grids, not graph engines. A card is
one functional collection, with no category tabs, branches, file nodes, pan or
zoom. Search checks both collection metadata and every file inside it.

Selecting a card writes its collection id to `?node=` and opens one sheet with
an introduction, the complete downloadable file list, a build-generated ZIP
and usage instructions. `/tools` uses the same interaction but has exactly two
nodes: `DOCUMENTS` and `MCP`.

## Downloading a document

Contributed Markdown is authored by strangers, so the collection sheet keeps
its body inert. The service derives a plain-text name and description, while a
file row downloads the original bytes. The page never turns a contributed body
into HTML, follows its links or loads its images.

## The machine installer

`frontend/scripts/machine/` installs the catalogue onto a developer's machine
as agent instructions. `frontend/public/install.py` is its
dependency-free bootstrap: it maintains a sparse checkout, hands global setup
to the existing TUI, expands MCP product selections to registry servers, or
installs a managed project copy under `.agents/rules/hub-william`.

Its own suite (`bash frontend/scripts/machine/tests/run.sh`) pins the catalogue's layout on
purpose, and runs in CI for that reason. A contract that moves without its
references breaks the harness rather than the site, and nothing else would
catch it.

## Deployment

GitHub Actions builds and publishes to one `gh-pages` branch: `main` to the
site root, `dev` to a `dev/` subfolder. `VITE_BASE_PATH` threads the same prefix
through Vite's `base` and React Router's `basename`, because a project site is
served from `/<repository>/` rather than the domain root.

`backend/` is prepared for a later Railway deployment, but this structural
change does not create or mutate remote infrastructure. `infra/README.md`
records that boundary until a real deployment owns provider-specific config.

`main` is protected: no direct pushes, and a branch must be up to date with a
green `checks` run before it merges.
