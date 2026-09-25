# Hub William

Hub William brings shared agent accounts, coding tools, organizations and a
browser Playground into one workspace. Local tools use a revocable gateway key;
Playground uses your signed-in Hub session and an account you own, a pool you
have joined or an agent shared with your organization.

**[hub-william.site](https://hub-william.site)**

[Architecture](apps/frontend/docs/architecture.md) ·
[Frontend conventions](apps/frontend/docs/frontend-conventions.md) ·
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
  supported images, text files and PDFs as input. Conversations stay in the open
  page rather than a saved history; voice and native image generation are not
  available yet.
- **Organization** (`/organization`): create or join multiple teams, invite
  members, share connected agents, and view organization requests and reported
  token usage in Overview, Agents, Members and Usage.

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
contributors/*/libraries/              repository development workflow sources
infra/                                 deployment configuration
```

Development harnesses, skills, hooks and templates remain repository workflow
sources. They are not part of the app catalogue or its downloadable build.

The Rust API owns authentication, rotating browser sessions, encrypted provider
connections, account pools, organization membership and shares, and user-scoped
gateway keys. An accepted pool member can use their own Hub key through a shared
pool; an accepted organization member can use a shared agent in Playground.
Neither flow exposes upstream provider credentials.

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
Railway workflow deploys the API, Telegram adapter and frontend to the existing
production project. Add a production-scoped Railway project token as the GitHub
Actions secret `RAILWAY_TOKEN`; until it is present, deployment is explicitly
skipped. After adding it, run **Deploy to Railway** manually from `main` if no
new `main` push is planned. Runtime credentials and database settings stay in
Railway variables, not GitHub. GitHub Pages and Vercel publishing are retired.

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

## Contributing

Community pull requests are for Markdown tool documentation in the author's own
`contributors/<github-login>/tools/<tool-name>/` folder and target `dev`.
The Tools catalogue groups docs by contributor and tool; it has no separate
category field. For API, frontend, installer, workflow, convention, or other
repository changes, [open an issue](https://github.com/synasapmob/hub-william/issues/new/choose)
instead. `contributors/default/` and `contributors/*/libraries/` are maintained
internally. Read the [contribution guide](.github/CONTRIBUTING.md) before
opening a pull request.

## Stack

React · TypeScript · Vite · React Router · Tailwind CSS · TanStack Query ·
Rust · Axum · PostgreSQL · Utoipa/OpenAPI · Vitest · Python
