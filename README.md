# Hub William

A monorepo for the Hub William agent workspace: the public catalogue frontend,
the machine-installable contracts behind it, and the Rust control plane and
streaming gateway for connected agent accounts.

**[synasapmob.github.io/hub-william](https://synasapmob.github.io/hub-william/)**

📖 [Architecture](apps/frontend/docs/architecture.md) ·
[Frontend conventions](apps/frontend/docs/frontend-conventions.md) ·
[Decisions](docs/decisions/README.md) ·
[Contributing](.github/CONTRIBUTING.md) ·
[Security](.github/SECURITY.md) ·
[MIT License](LICENSE)

## What problem this solves

An agent given a whole codebase and a shell will invent dependencies, break
tests, ignore the conventions of the repository it is in, and open a pull
request nobody can review. Prompting harder does not fix it, because the
failure is not a wording problem — the agent has no boundary it must not
cross, and nothing that fires when it tries.

So the boundary gets written down, in four kinds of document:

|               | What it is                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Harnesses** | Execution modes and modifiers. A tag you type — `[plan]`, `[delivery-local]`, `[report]` — and the contract the agent must load before it plans, mutates, writes outside the checkout, or shapes its final handoff. |
| **Skills**    | One discipline's rules, loaded when the task matches, so they are in context when they apply and absent when they do not.                                                                                           |
| **Hooks**     | Contracts that fire around an action — before a GitHub write, before a Linear issue, before evidence is claimed — whether or not a tag asked for them.                                                              |
| **Templates** | The shapes the work is written into: pull requests, issues, approach histories, test evidence. Two agents produce the same artefact.                                                                                |

None of that is a framework. Every one of them is a Markdown file in this
repository, which is the point: a boundary you can read, review in a diff, and
disagree with.

## What is here by default

Every document belongs to somebody, including the shared ones.
`contributors/default/` is the catalogue this project ships; your own workspace
sits beside it under your GitHub login, in exactly the same shape. Browse them
at [`/library`](https://synasapmob.github.io/hub-william/library) and
[`/tools`](https://synasapmob.github.io/hub-william/tools):

```text
contributors/
├── default/                     what this project ships
│   ├── libraries/
│   │   ├── harness/             execution modes, and the contracts around them
│   │   │   ├── tags/            the modes you type
│   │   │   ├── github/          gh CLI use, clickable references, reporting
│   │   │   └── evidence/        approach history, test evidence, reporting
│   │   ├── skills/              one discipline's rules, loaded on demand
│   │   └── templates/           the shapes work is written into
│   └── tools/
│       ├── installer/           getting the catalogue onto a machine
│       └── mcp/                 registering MCP servers across agents
└── <your-login>/                the same two folders, yours
    ├── libraries/
    └── tools/

apps/frontend/scripts/machine/        the installer, and its own test suite
```

`/library` groups documents by the job they do rather than duplicating the
source tree. A GitHub workflow tag such as `mergeable` therefore appears in the
same `GITHUB` collection as `gh-cli.md`, while both keep their original paths.
`/tools` reduces installation to two collections: `DOCUMENTS` and `MCP`.

**Start from these, and change what does not fit.** They are written for one
operator's machine and one set of tools; a repository with different CI, a
different tracker, or no tracker at all should reuse the parts that transfer and
replace the rest. Nothing here is load bearing for the site — the catalogue is
whatever files are in the folder.

## How to contribute

Everything on the canvas is a Markdown file, so contributing is opening a pull
request that adds one. There is no upload, no account, and nothing to run.

**If you want to extend something rather than change it for everybody**, add it
under your own name. A contract that maps _your_ repositories to _your_ servers
is yours, not everyone's — and keeping it out of the shared catalogue is what
keeps the shared one worth reading.

1. Fork this repository.
2. Create `contributors/<your-github-login>/` and file your document under the
   section and the kind it is:

   ```text
   contributors/<your-github-login>/
   ├── libraries/
   │   ├── harness/<name>.md          an execution mode
   │   ├── skills/<name>/SKILL.md     a skill, with YAML front matter
   │   ├── hooks/<name>.md            a contract that fires around an action
   │   └── templates/<name>.md        a shape to write into
   └── tools/
       └── <name>/<name>.md           how to install or run something
   ```

   The folder name must be your GitHub login. That is what publishes your page
   at `/library/<your-login>` and what shows your avatar beside it.

3. Write the document. A heading and a first paragraph are enough — the site
   takes the entry's name and description from them, and never edits your file.
   A skill also needs front matter, because that is what its format requires:

   ```markdown
   ---
   name: your-skill
   description: One line saying when this should be loaded.
   ---
   ```

4. Open a pull request. CI runs formatting, linting, type checking, tests, a
   production build and the catalogue's own suite. Once it merges, your page is
   prerendered and deployed — nobody has to register it anywhere.

Changing a shared document is the same flow without step 2. Say in the pull
request why the rule should apply to everybody rather than to you; that is the
whole difference between the two folders.

## Repository layout

```text
apps/api/                         Rust business API, OpenAPI and gateway module
apps/frontend/                    React Router frontend and public web assets
apps/telegram/                    Telegram webhook adapter for the private business API
contributors/                    installable contracts published by the frontend
apps/frontend/scripts/machine/        machine installer and its tests
infra/                           deployment ownership and future provider config
```

The API exposes username/password auth, rotating PostgreSQL-backed browser
sessions, encrypted ChatGPT/Claude/Grok connections, public connected-account
pools, durable join decisions, revocable gateway keys, provider routing,
`/health`, generated OpenAPI, and Swagger UI.

An accepted pool membership authorizes that user's own gateway key to route
through the shared provider account. Provider credentials remain encrypted in
the API and are never returned to the member's browser or local agent.

## Working in the monorepo

```bash
pnpm install
pnpm dev             # frontend
pnpm api:dev         # Rust API on :8080
pnpm telegram:dev    # Telegram webhook adapter on :8090
```

The frontend needs no environment variables or services; the catalogue is read
from disk at build time. The API accepts an optional `PORT` and otherwise
listens on `8080`.

```bash
pnpm format         # prettier
pnpm lint           # oxlint, then eslint
pnpm check:tailwind # canonical Tailwind class lists (--write to fix)
pnpm typecheck      # tsc -b
pnpm test           # vitest
pnpm build          # prerenders the frontend and compiles the API
bash apps/frontend/scripts/machine/tests/run.sh # installer suite; pins the catalogue layout
```

Read [frontend conventions](apps/frontend/docs/frontend-conventions.md) before changing
anything user-visible. They are review criteria, not suggestions.

## Installing it

The public bootstrap clones or updates the catalogue and opens the terminal
picker. Its default scope is the whole machine:

```bash
curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 -
```

Install a managed copy into one project, preserving its existing instruction
files:

```bash
curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 - --path "$PWD"
```

MCP servers can be installed together or by product:

```bash
curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 - --mcp all
curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 - --mcp linear,playwright
```

## Reading it as an agent

The site is prerendered, so fetching a page gives real text rather than an empty
shell. For the files themselves there is no need to scrape anything:

| URL                                                 | What it is                                             |
| --------------------------------------------------- | ------------------------------------------------------ |
| `/catalog/index.json`                               | Every document: id, repository path, URL, size         |
| `/catalog/<id>.md`                                  | One document, byte for byte as it is in the repository |
| `/catalog/collections/<owner>/<section>/<name>.zip` | One functional collection with source paths preserved  |

They are static files under the site's base path, so an agent can read the
index, pick a contract and fetch it without an API, a token, or HTML parsing.

## Stack

React 19 · TypeScript · Vite 8 · React Router 8 (SPA, prerendered) ·
Tailwind CSS 4 · Rust · Axum · Utoipa/OpenAPI · Vitest · Oxlint · Prettier

## What remains fixture data

`/activities` remains fixture telemetry behind
`apps/frontend/src/utils/utils.activities.ts`. `/agents` reads connected accounts,
memberships, and request decisions from the backend with no mock fallback.
Pool cards load live 5-hour, weekly, and reset-credit figures from each
connected provider. The browser never fabricates those numbers. `/activities`
remains fixture telemetry. The sidebar's former Recent updates fixture has been
removed.
