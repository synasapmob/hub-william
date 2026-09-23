# Frontend

React Router SPA for Home, Tools, Agents and the model Playground. Home is the
white paper. Tools reads shared and contributed documentation from
`../../contributors/*/tools/` at build time, including Gateway, OpenCode and
OMP. Agents and the session-backed Playground use the Rust API. Playground
streams text from the selected accessible account and keeps its conversation
only while the page remains open.

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
