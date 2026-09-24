# Frontend

React Router SPA for Home, Tools, Agents, Organization and the model Playground. Home is the
white paper. Tools reads shared and contributed documentation from
`../../contributors/*/tools/` at build time, including Gateway, OpenCode and
OMP. Agents and the session-backed Playground use the Rust API. Playground
streams text from the selected personal or organization-shared account and keeps
its conversation only while the page remains open. Organization routes show
Overview, Agents, Members and Usage for the selected team.
Organization Agents uses the Workspace provider/account explorer. Its detail
dialog shows quota only for supported providers and 30-day organization usage
only for accounts with recorded requests. Members and owners can use Connect
Agent to share an existing account or connect and share a new one with the team.
Organization creation accepts an optional description of up to 350 characters.

From the repository root:

```bash
pnpm install
pnpm dev
```

Set `VITE_API_BASE_URL` in `apps/frontend/.env` to select the API used during
local development. Railway builds use the same-origin `/api` proxy.

Root developer commands delegate to this workspace. Standalone installer
checks live in `scripts/installers/tests/`; the retired Documents machine
installer is no longer distributed.
