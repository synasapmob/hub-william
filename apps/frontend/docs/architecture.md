# Architecture

Hub William is a monorepo with a mostly static catalogue frontend and a Rust
business API with an in-process streaming gateway module. `apps/api` owns
username/password auth,
rotating PostgreSQL-backed sessions, encrypted provider connections,
PostgreSQL-backed agent pools and join decisions, and user-scoped gateway keys
alongside health and OpenAPI documentation.

## The shape

```text
contributors/**/*.md       the catalogue — contracts, skills, templates
        │
        │  import.meta.glob(..., { query: "?raw", eager: true })
        ▼
apps/frontend/src/services/catalog  parses front matter, derives collections
        │
        ▼
apps/frontend/src/routes/…          renders functional collection nodes
        │
        │  react-router prerender
        ▼
apps/frontend/build/client/**/*.html  real HTML per route

apps/frontend/src/services           calls auth, pool, connection and key contracts
        │
        │  TanStack Query cache; production: same-origin /api proxy
        ▼
apps/api/src                     Axum business API, provider OAuth and gateway module
        │
        ▼
Railway PostgreSQL              users, opaque key hashes and encrypted tokens
```

The catalogue needs no fetch to render and is inlined into the bundle at build
time, so what the site publishes is exactly what the repository contains at the
commit it was built from. Pools are public API data derived only from connected
provider accounts; join requests and owner decisions are session-gated and
persisted in PostgreSQL. A shared session provider checks the Rust API;
account-bound actions, provider OAuth and gateway keys use that live boundary.
An accepted pool member can create a user-scoped key and route through the
owner's shared provider without receiving the provider token.
Pool owners manage pending requests, direct username invites, accepted members,
and exact-pool retry controls in the pool access dialog. Provider availability
is server state: a 30-minute `429` cooldown is displayed by the UI, while manual
refresh only arms the pool for verification by the next real gateway request.
The build also writes that catalogue
out as files — `/catalog/<path>`,
`/catalog/<folder>.zip`, `/catalog/collections/<owner>/<section>/<name>.zip`
and `/catalog/index.json` — which is what a download button and a `curl` command
both fetch. Runtime account traffic stays on the same origin under `/api`.

## Why the catalogue remains static

The thing this site publishes is already a set of files under version control,
reviewed by pull request. A database in front of that would add a second source
of truth, a way for the two to disagree, and an account system to protect
writes that a pull request already gates.

The consequences are worth naming, because each one is something the code now
relies on:

- **Every route prerenders.** Catalogue content needs no runtime fetch, so each
  route can be written to HTML at build time. Dynamic `/agents` data hydrates
  from the same-origin API after the public shell renders.
- **The CSP can be strict.** `connect-src 'self'` covers the same-origin `/api`
  proxy without exposing a separate browser-visible backend origin. Downloading
  an archive remains a navigation to the site's own origin.
- **A contribution is a diff.** Adding an entry is adding a file; removing one
  is removing a file. There is no migration, no seed, and no admin screen.
- **Freshness is a deploy.** The catalogue changes when `main` changes. If that
  ever becomes too slow, the answer is a build hook, not a database.
- **No route is behind an account.** The specification, catalogue, telemetry,
  and pool discovery stay public. Requesting or managing pool membership crosses
  the backend auth boundary without redirecting the reader away from a route.

`/activities` remains fixture telemetry. `/agents` has no runtime fixture
fallback: an account appears only after its provider connection is stored as
connected by the backend, and pool usage is fetched live from that provider.
The former sidebar recent-updates fixture was removed when that space became
the session control.

## The catalogue

`apps/frontend/src/services/catalog` is the only module that knows the folder exists. It
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

`apps/frontend/scripts/machine/` installs the catalogue onto a developer's machine
as agent instructions. `apps/frontend/public/install.py` is its
dependency-free bootstrap: it maintains a sparse checkout, hands global setup
to the existing TUI, expands MCP product selections to registry servers, or
installs a managed project copy under `.agents/rules/hub-william`.

Its own suite (`bash apps/frontend/scripts/machine/tests/run.sh`) pins the catalogue's layout on
purpose, and runs in CI for that reason. A contract that moves without its
references breaks the harness rather than the site, and nothing else would
catch it.

## Deployment

Railway hosts the production application. Its public Nginx frontend serves the
prerendered SPA and proxies `/api` to the private, IPv6-listening `apps/api`
service;
only the frontend has a public domain. Local development calls the Rust service
directly on port 8080. GitHub Pages can continue publishing the static catalogue,
but authenticated runtime flows require the Railway deployment.

The provider streaming code remains `apps/api/src/gateway.rs` until it has a
real independent service contract. That future `apps/gateway` service will be
public for local agent clients. `apps/api` and a future `apps/worker` use
Railway private networking for control-plane work; `apps/telegram` has a
separate public HTTPS webhook solely for Telegram, then calls the API through
that same private network.

`main` is protected: no direct pushes, and a branch must be up to date with a
green `checks` run before it merges.
