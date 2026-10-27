# Hub William

Hub William brings shared agent accounts, coding tools, organizations and a
browser Playground into one workspace.

[Architecture](docs/architecture.md) · [Contributing](.github/CONTRIBUTING.md) ·
[Security](.github/SECURITY.md) · [MIT License](LICENSE)

## Why Hub William

- **Share an account, not its credentials.** Connect a provider account once.
  Teammates use it through an account pool or an organization with their own Hub
  key. Requests go through the gateway, so tools and teammates hold a Hub key,
  never the provider credential.
- **One key for your tools.** A revocable, user-scoped gateway key points your
  local agent CLIs at Hub William.
- **Keep working when an account fails.** When an account is rate limited, needs
  reconnecting or refuses a request, the API moves to the next account of the
  same provider and fails only when none is left.
- **Try it in the browser.** Playground uses the same accounts and pools, with no
  local setup.

## How it works

Hub William sits between your agents and the provider accounts behind them. You
connect an account once, and everyone you share it with reaches it through Hub
William.

```text
Agent CLIs on your computer ──(Hub key)──────────┐
                                                 ├─▶ Hub William API ──▶ provider accounts
Playground in the browser ──(signed-in session)──┘   gateway · pools · organizations
```

1. **Connect.** The owner connects a provider account with a provider sign-in or
   an API key. The API stores the credentials encrypted and refreshes them in the
   background.
2. **Share.** The owner shares the account through an account pool or with an
   organization. A member must be accepted before they can use it.
3. **Point your tools at it.** A Hub key, which is user-scoped and revocable,
   goes into your agent's configuration. The installers on the Tools page write
   it for you.
4. **Send requests.** Your agent calls the gateway route of a provider
   (`/gateway/<provider>/…`). The API picks an account you own or were accepted
   to use, refreshes its credential if it is about to expire, and streams the
   provider's response back. If that account fails, the API tries the next one
   of the same provider. Playground does the same with your signed-in session.

Provider credentials stay encrypted in the API. Your computer holds a Hub key,
and each teammate holds their own.

### Tools

The **Tools** page is a catalogue of small tools and guides for working with
your agents. Some come with a one-line command that sets a tool up on your
computer, so you don't edit each agent's configuration by hand. Anyone can
contribute a guide (see [Contributing](#contributing)).

Example, using Hub William with OpenCode. Create a Hub key under **Agents**
first.

1. Run the installer with your key. Replace `YOUR_GATEWAY_KEY`; the key may stay
   in your shell history.

   ```sh
   curl -fsSL https://hub-william.site/opencode.py | python3 - \
     --url=https://hub-william.site/api \
     --key=YOUR_GATEWAY_KEY
   ```

   It backs up your OpenCode config once, then writes the models your key can
   reach to `~/.config/opencode/opencode.json`. A revoked or invalid key stops the
   installer without changing your config.

2. Start `opencode`. Use `/models` to switch provider or model and `/variants` to
   switch reasoning effort.
3. Run the command again whenever you want the model list refreshed.

## Installation

Create a Hub key under **Agents**, then run:

```sh
# Point Codex, Claude Code, Grok and Antigravity at Hub William.
# Prompts for your Hub key without echoing it.
curl -fsSL https://hub-william.site/gateway.py | python3 - \
  --url=https://hub-william.site/api

# Install the shared skills into ~/.agents.
# Existing skills are backed up first; unlink.sh undoes it.
curl -fsSL \
  https://hub-william.site/catalog/contributors/synasapmob/tools/link-skills/link.sh | bash
```

`link.sh` runs a script fetched from Hub William. To read it first, download the
Skills zip from the Tools page and run `link.sh --path=~/Downloads/skills.zip`,
which fetches nothing. OpenCode, OMP and Memory have their own instructions on
the Tools page.

## Stack

- **Frontend:** React · TypeScript · Vite · React Router · Tailwind CSS ·
  TanStack Query · Vitest
- **API:** Rust · Axum · SQLx · PostgreSQL · Utoipa/OpenAPI
- **Telegram adapter:** Rust · Axum · Tokio · Reqwest. It runs the Telegram shop
  (orders paid through SePay), has no database and calls the private API for
  everything it stores.
- **Installers:** Python (`gateway.py`, `opencode.py`, `omp.py`) and Bash
  (`download-reel.sh`, `link.sh`)
- **Hosting:** Railway

## Contributing

Community pull requests are for Markdown tool documentation in your own
folder. For anything else (API, frontend, installers, workflows, conventions)
[open an issue](https://github.com/synasapmob/hub-william/issues/new/choose)
first. Read the [contribution guide](.github/CONTRIBUTING.md) before you start.

### Folder structure

```text
contributors/
├── default/                  # system (read-only)
│   └── tools/
│       ├── download-reel/
│       ├── edge-tts/
│       ├── gateway/
│       ├── omp/
│       ├── opencode/
│       └── vosk/
└── <your-github-login>/       # your contributions
    └── tools/
        └── <tool-name>/
            └── README.md
```

- Use your GitHub login in lowercase and a lowercase, hyphenated tool name.
- Start with `README.md` or `<tool-name>.md`. The check accepts any Markdown
  file inside your tool folder.
- Markdown files only. No symbolic links, executable files or credentials.
- Never edit `contributors/default/` or another contributor's folder; the pull
  request will fail.

### Step by step

1. **Fork and clone**, then branch from `dev`:

   ```sh
   gh repo fork synasapmob/hub-william --clone
   cd hub-william
   git switch -c add-<tool-name> origin/dev
   ```

2. **Add your tool.** Create `contributors/<your-github-login>/tools/<tool-name>/README.md`
   as in the structure above. Say what the tool does and how to use it, and cite
   official documentation for claims that can change.

3. **Commit and push:**

   ```sh
   git add contributors/<your-github-login>/tools/<tool-name>/
   git commit -m "docs(tools): add <tool-name>"
   git push -u origin add-<tool-name>
   ```

4. **Open the pull request into `dev`** (never `main`) and fill in the template:
   what the tool does, how to use it and how you verified the instructions.

   ```sh
   gh pr create --base dev
   ```

5. **Review.** An automated check verifies the author, target branch, changed
   paths, file types and file modes. A maintainer then reviews the content and
   links; passing the check is not acceptance. A merged change reaches staging
   first. Once a maintainer promotes `dev` to production, your tool appears under
   your login on the Tools page.

### Run the project locally

For repository owners and anyone working on an issue a maintainer accepted:

```sh
pnpm install
pnpm dev             # frontend
pnpm api:dev         # Rust API on :8080
pnpm telegram:dev    # Telegram adapter on :8090
```

Set `VITE_API_BASE_URL` in `apps/frontend/.env` to `http://localhost:8080` to use
the local API. The API needs PostgreSQL and a few required environment
variables; [deployment](docs/architecture/deployment.md) lists them. Before you
open a pull request, run the checks listed in the contribution guide, starting
with:

```sh
pnpm format:check && pnpm lint && pnpm check:tailwind && pnpm typecheck && pnpm test && pnpm build
```
