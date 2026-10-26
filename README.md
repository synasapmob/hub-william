# Hub William

Hub William brings shared agent accounts, coding tools, organizations and a
browser Playground into one workspace. Local tools use a revocable gateway key;
Playground uses your signed-in Hub session and an account you own, a pool you
have joined or an agent shared with your organization.

**[hub-william.site](https://hub-william.site)**

[Architecture](apps/frontend/docs/architecture.md) ·
[Frontend conventions](apps/frontend/docs/frontend-conventions.md) ·
[Provider catalogue](docs/provider-catalogue.md) ·
[Decisions](docs/decisions/README.md) ·
[Contributing](.github/CONTRIBUTING.md) ·
[Security](.github/SECURITY.md) · [MIT License](LICENSE)

## App

- **[Home](https://hub-william.site):** white paper about sharing tools and agent
  pools with teammates, plus the contribution workflow.
- **[Tools](https://hub-william.site/tools):** Gateway, OpenCode and OMP setup,
  documentation and standalone installers.
- **[Agents](https://hub-william.site/agents):** connected provider accounts,
  usage, pool membership, owner management and gateway keys.
- **[Playground](https://hub-william.site/playground):** streaming text
  conversations using your connected accounts and approved pools. You can attach
  supported images, text files and PDFs as input. Call mode offers native voice
  with `gpt-live-1-codex`, a local camera preview and transcripts from both
  speakers. Each mode lists only its supported models. Conversations stay in
  the open page rather than a saved history; native camera understanding and
  image generation are not available yet.
- **Organization** (`/organization`): create or join multiple teams, invite
  members, share connected agents, and view organization requests and reported
  token usage in Overview, Agents, Members and Usage. **My organizations** lists
  your teams with their owner, agents, members, tokens and creation date, sets
  your default team on your account, handles invitations (a bell beside Log out in the sidebar
  links to them), and lets an owner delete a team or a member leave it. A
  shared agent stays linked to its owner's Workspace account: refreshing it on
  either side updates both, deleting it in Workspace removes it from every
  organization, and removing it from an organization keeps the Workspace
  account.

Libraries, Activities, Documents installation and MCP installation are retired.
The old machine bootstrap (`install.py` / `install.sh`) is removed.

## Repository layout

```text
apps/api/                              Rust API, OpenAPI and streaming gateway
apps/frontend/                         React Router frontend
apps/frontend/public/{gateway,opencode,omp}.py
                                       standalone tool installers
apps/frontend/scripts/installers/tests/ installer and gateway proxy tests
apps/telegram/                         Telegram adapter for the business API
contributors/*/tools/                  shared and contributor tool documentation
infra/                                 deployment configuration
```

The Rust API owns authentication, rotating browser sessions, encrypted provider
connections, account pools, organization membership and shares, and user-scoped
gateway keys. An accepted pool member can use their own Hub key through a shared
pool; an accepted organization member can use a shared agent in Playground.
Neither flow exposes upstream provider credentials. When the chosen account is
rate limited, needs reconnecting or refuses a request, the API rotates to the
next account of the same provider in the same scope and fails only once that
pool is exhausted. Connected OAuth accounts refresh in the background every
30-45 minutes.

## Development

```bash
pnpm install
pnpm dev             # frontend
pnpm api:dev         # Rust API on :8080
pnpm telegram:dev    # Telegram adapter on :8090
```

The frontend reads `VITE_API_BASE_URL` from `apps/frontend/.env`. Set it to
`https://hub-william.site/api` for the deployed API or `http://localhost:8080`
for a local API. Direct browser requests to another origin require that API's
CORS and session-cookie policy to allow the frontend origin. The Railway
frontend uses its same-origin `/api` proxy.

```bash
pnpm format:check
pnpm lint
pnpm check:tailwind
pnpm typecheck
pnpm test
pnpm build
bash apps/frontend/scripts/installers/tests/run.sh
```

Read the frontend conventions before changing UI. The installer suite uses
temporary directories and mocked discovery responses to verify configuration
writes without changing the operator's installed agent settings.

## Deployment

Owner pull requests run full CI; community pull requests run the trusted
contribution-scope check without executing their changed files. After a verified
`dev` change is promoted to `main`, the
Railway workflow deploys the API, Telegram adapter and frontend to the
`production` environment. A push to `dev` deploys the API and frontend to the
`staging` environment, which has no Telegram adapter. Each environment has its
own Railway project token, stored as the Actions secret `RAILWAY_TOKEN` of the
GitHub environment with the same name; a run fails when it is missing. After
fixing a secret, rerun the failed run, or run **Deploy to Railway** manually from
`dev` or `main`. Runtime credentials and database settings stay in Railway
variables, not GitHub. GitHub Pages and Vercel publishing are retired.

## Tool installation

Open Tools for the current setup instructions, or run one installer. Each one
prompts for your Hub key without echoing it:

```bash
curl -fsSL https://hub-william.site/gateway.py | python3 - --url=https://hub-william.site/api
curl -fsSL https://hub-william.site/opencode.py | python3 - --url=https://hub-william.site/api
curl -fsSL https://hub-william.site/omp.py | python3 - --url=https://hub-william.site/api
```

The installers store the Hub key locally; provider OAuth credentials stay on the
API. OpenCode and OMP discover the models reachable through that key, then write
it into their provider settings. You can also pass `--key=YOUR_GATEWAY_KEY` after
`--url` if you prefer to supply a key explicitly. An invalid or revoked key
stops installation before either config is changed.

Tool documentation is included at build time and remains downloadable as its
original bytes. `/catalog/index.json` lists tool sources;
`/catalog/collections/<contributor>/tools/<tool>.zip` contains a tool's documentation.

### Browse and manage what agents remember

**Memory** (`contributors/synasapmob/tools/memory/`) opens a terminal browser of what Claude
Code, Codex, Grok and agy remember: the instruction files you write (`CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`) and the lessons they save about you. Open an agent to see its global files and each
project, open a file to read it (read-only), and press `d` to move learned memory to the Trash
after a preview. Instruction files and databases are never changed, and nothing is deleted for
good. It needs Python 3.9 or newer on macOS or Linux and makes no network request:

```sh
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/memory/memory.py | python3

# Print the table without the interface; nothing is changed.
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/memory/memory.py | python3 - --list
```

### Install the shared skills

The **Skills** tool of `@synasapmob` (`contributors/synasapmob/tools/skills/`: five
skills and the shared rules) is one card and one zip. **Link skills** (`link.sh` and
`unlink.sh`) installs it into `~/.agents`, in one of two ways:

```sh
# From Hub William, if you trust it: the script fetches the skills itself.
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/link-skills/link.sh | bash

# From your own copy: download the Skills zip, then point the script at it.
# PATH is the zip, or the folder you unzipped it into. Nothing is fetched.
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/link-skills/link.sh | bash -s -- --path=~/Downloads/skills.zip
```

It never deletes your work: existing skills are backed up, a rules file you edited
is kept (an unedited one is backed up and updated), and existing agent links are
left alone. `unlink.sh` undoes it.

## Contributing

Community pull requests are for Markdown tool documentation in the author's own
`contributors/<github-login>/tools/<tool-name>/` folder and target `dev`.
The Tools catalogue groups docs by contributor and tool; it has no separate
category field. For API, frontend, installer, workflow, convention, or other
repository changes, [open an issue](https://github.com/synasapmob/hub-william/issues/new/choose)
instead. `contributors/default/` is maintained internally. Read the [contribution guide](.github/CONTRIBUTING.md) before
opening a pull request.

## Stack

React · TypeScript · Vite · React Router · Tailwind CSS · TanStack Query ·
Rust · Axum · PostgreSQL · Utoipa/OpenAPI · Vitest · Python

Groq is also available through **Connect Agent → Groq** with your own API key.
Playground Chat offers current Qwen/GPT-OSS models advertised by that key.
Call recognizes English speech locally in the browser, then uses Groq for
GPT-OSS replies and Orpheus speech. The model downloads on first use; microphone
audio and camera remain local. Only text generation and speech output consume
Groq quota. See [browser-local STT](docs/decisions/0037-browser-local-speech-recognition.md).
