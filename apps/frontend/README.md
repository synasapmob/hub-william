# Frontend

React Router SPA for Home, Tools, Agents, Organization and the model Playground.
Tools reads its documentation from `../../contributors/*/tools/` at build time.
Agents, Organization and the session-backed Playground use the Rust API. How the
app works is documented in [`docs/architecture/`](../../docs/architecture.md):
[frontend](../../docs/architecture/frontend.md),
[organizations](../../docs/architecture/organizations.md),
[Playground](../../docs/architecture/playground.md),
[speech](../../docs/architecture/speech.md) and
[tools](../../docs/architecture/tools.md).

From the repository root:

```bash
pnpm install
pnpm dev
```

Set `VITE_API_BASE_URL` in `apps/frontend/.env` to select the API used during
local development. Railway builds use the same-origin `/api` proxy.

To use the staging API with only the frontend running locally:

```bash
VITE_API_BASE_URL=/api DEV_API_PROXY_TARGET=https://hub-william-staging.up.railway.app pnpm dev
```

The loopback dev server proxies `/api` and translates its own request origin to
staging. Sign in on the local page; browser sessions are separate from the staging
site. Staging cookie and origin restrictions remain unchanged.

For plain `pnpm dev` to use the same configuration, save both variables in
`apps/frontend/.env`:

```dotenv
VITE_API_BASE_URL=/api
DEV_API_PROXY_TARGET=https://hub-william-staging.up.railway.app
```

Call Whisper supports English speech only. Whisper recognition and Piper
phonemization are fixed to `en`, with the English Piper voice. Reload and start a
new call after changing speech-worker code.

Root developer commands delegate to this workspace. Standalone installer checks
live in `scripts/installers/tests/`.
