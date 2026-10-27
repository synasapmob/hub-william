# Deployment and operations

Hub William runs on Railway as three application services (frontend, API, Telegram adapter) and one Postgres database. Branches map to Railway environments through one workflow, pull requests are checked by two GitHub workflows, and the public edge is an nginx image that serves the frontend build and proxies `/api`. This document covers the topology, the pipelines, the edge rules, the API runtime configuration and local development.

## Deployables

| Service    | Source           | Image                                             | Listens                      | Role                                                                    |
| ---------- | ---------------- | ------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `frontend` | `apps/frontend`  | `node` builder, then `nginx:1.29-alpine`          | `:80` (IPv4 and IPv6)        | Serves the prerendered SPA and `/catalog/`, proxies `/api/*` to the API |
| `api`      | `apps/api`       | `rust:1.98-bookworm`, then `debian:bookworm-slim` | `[::]:$PORT`, default `8080` | Business API, in-process agent gateway, background credential sweeps    |
| `telegram` | `apps/telegram`  | `rust:1.98-bookworm`, then `debian:bookworm-slim` | `[::]:$PORT`, default `8090` | Telegram and SePay webhooks ([telegram](./telegram.md))                 |
| Postgres   | Railway database | n/a                                               | n/a                          | All persistent state; the API runs its migrations at startup            |

Facts about public domains, private hostnames and Railway variables are service settings in Railway, not repository files. As documented in `infra/README.md`:

- `frontend` is the public entry point, and reaches `api` over Railway private networking through `API_INTERNAL_URL`.
- `api` has no public domain.
- `telegram` has its own public HTTPS domain, used for the Telegram and SePay webhooks and for the payment QR image that Telegram fetches (`GET /qr.png`). It calls `api` over the private network with a separate service token.

The repository root is the Docker build context for all three images (the `Dockerfile`s copy `apps/…`, `contributors/` and `infra/` paths from it). Cargo has no workspace: `apps/api` and `apps/telegram` are separate crates with their own `Cargo.lock`, and the root scripts address them with `--manifest-path`. `pnpm-workspace.yaml` contains only `apps/frontend`.

```text
browser ──HTTPS──► frontend (nginx)
                     ├─ /            static build, SPA fallback
                     ├─ /catalog/    published tool sources and ZIPs
                     └─ /api/*  ──private──► api ──► Postgres
                                              └────► provider APIs (gateway)
Telegram / SePay ─HTTPS─► telegram ──private──► api (/internal/telegram/*)
```

## Branches and environments

`.github/workflows/railway-deploy.yml` runs on every push to `main` or `dev` and on `workflow_dispatch`.

| Branch | Railway and GitHub environment | Services deployed, in order   |
| ------ | ------------------------------ | ----------------------------- |
| `main` | `production`                   | `api`, `telegram`, `frontend` |
| `dev`  | `staging`                      | `api`, `frontend`             |

- The branch selects the Railway environment, the GitHub environment and therefore the `RAILWAY_TOKEN` secret the job reads. A missing token fails the run and names the environment that was not deployed.
- The job runs only in `synasapmob/hub-william`. A manual run from any branch other than `main` or `dev` is skipped.
- Each environment has its own concurrency group (`railway-production`, `railway-staging`) with `cancel-in-progress: false`, so runs queue per environment and a staging deploy never waits for production.
- Each service is deployed with `railway up --detach --json` (Railway CLI `5.49.6`, installed with Node 24). The job then polls `railway deployment list` every 10 seconds, up to 90 times (15 minutes per service), until the deployment reaches `SUCCESS`. `FAILED`, `CRASHED`, `REMOVED`, `REMOVING`, `SKIPPED`, `NEEDS_APPROVAL` and `SLEEPING` fail the job, and a failure stops the later services (`set -euo pipefail`). The job timeout is 60 minutes.
- The deploy runs after the push; it is not gated by CI. Both branches are protected (below), so changes arrive through checked pull requests.
- A merge into `dev` therefore reaches staging; production receives code only when the owner promotes `dev` into `main`.

Railway is the only deployment target. No workflow publishes to GitHub Pages or Vercel; `.github/workflows/` holds `railway-deploy.yml`, `trusted-ci.yml` and `contribution-policy.yml`.

### Branch protection

Read from the GitHub API (it is repository settings, not repository content): `main` and `dev` are protected identically. Required status checks are `checks` and `contribution-policy`, with branches required to be up to date; a pull request is required, with zero required approvals; the rules apply to administrators; conversation resolution is required; force pushes and deletions are blocked.

## Continuous integration

Two workflows run on `pull_request_target`, so the workflow definition always comes from the base branch.

**`trusted-ci.yml`** (job `checks`) runs for `workflow_dispatch`, or for pull requests whose author is the repository owner and whose head is in the same repository. Community pull requests skip it. The group `ci-<pr number or ref>` cancels superseded runs. Tool versions: pnpm 10, Node 24, Rust `stable` with `clippy` and `rustfmt`. Steps, in order:

1. `pnpm install --frozen-lockfile`
2. `node --test .github/scripts/contribution-policy.test.mjs`
3. `pnpm format:check`: provider-catalogue sync check, Prettier over the frontend, `README.md`, `docs`, `infra`, the API and Telegram READMEs, `catalogue.json`, root manifests and `.github`, then `cargo fmt --check` for both crates
4. `pnpm lint`: oxlint and ESLint (`--max-warnings 0`), then `cargo clippy --all-targets -D warnings` for both crates
5. `pnpm check:tailwind`: canonical Tailwind class names
6. `pnpm typecheck`
7. `pnpm test`: catalogue unit tests, Vitest, `cargo test` for both crates
8. `pnpm build`: catalogue check, frontend build, `cargo build --locked` for both crates
9. `python3 -m unittest discover -s tests -p 'test_*.py'` in `apps/frontend/scripts/installers`: installer config writes, model discovery, key and URL handling, `download-reel.sh`, the link and memory scripts, and the nginx gateway proxy contract (`test_gateway_proxy.py` pins the gateway-only `client_max_body_size 0`, the `/catalog/` content types and the Playground chat limits in `infra/nginx/default.conf.template`)

Not run in CI:

- The API tests behind the `database-tests` Cargo feature. CI provides no Postgres and passes no `--features`, so those tests are compiled out.
- Any check that `apps/api/openapi.json` and `apps/frontend/src/services/api/api.generated.ts` match the Rust handlers (see [OpenAPI contract](#openapi-contract)).

**`contribution-policy.yml`** (job `contribution-policy`) validates community pull requests without checking out their code. The owner is exempt. Everyone else must target `dev` and may change only Markdown files in their own tool folder, as ordinary non-executable blobs. The rules are in [tools](./tools.md).

## Edge (nginx)

`infra/nginx/default.conf.template` is installed as an nginx template; the image substitutes `${API_INTERNAL_URL}` and `${NGINX_LOCAL_RESOLVERS}` from the environment (the Dockerfile sets `NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1` so the image entrypoint fills the resolver list). The server listens on port 80 with root `/usr/share/nginx/html`, the Vite build of `apps/frontend`.

| Location                               | Rule                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `~ ^/assets/.*\.mjs$`                  | Served as `application/javascript` (ONNX Runtime loads an ES module from the emitted assets); `404` if absent                        |
| `~ ^/catalog/.+\.md$`                  | `text/markdown; charset=utf-8`, so the browser shows the file instead of downloading it                                              |
| `~ ^/catalog/.+\.(sh\|py)$`            | `text/plain; charset=utf-8`, for the same reason                                                                                     |
| `= /healthz`                           | `200 ok`, no access log                                                                                                              |
| `= /api/internal`, `^~ /api/internal/` | `404`: the Telegram adapter's internal routes are never reachable from the public side                                               |
| `^~ /api/gateway/`                     | Proxied to the API with `client_max_body_size 0` (no request limit)                                                                  |
| `= /api/playground/chat`               | Proxied with `client_max_body_size 32m`                                                                                              |
| `/api/`                                | Proxied with nginx's default `client_max_body_size` (the template does not override it)                                              |
| `/`                                    | `try_files $uri/index.html $uri /__spa-fallback.html`: prerendered route directories first, then the SPA shell for every other route |

All three proxy locations share the same behaviour: `rewrite ^/api/(.*)$ /$1 break` strips the `/api` prefix; `proxy_pass` uses the `$api_internal_url` variable, so nginx resolves the host name at request time through the configured resolver (`valid=10s`, IPv6 on) instead of at startup; `proxy_http_version 1.1`, `proxy_buffering off` (streamed responses reach the browser unbuffered) and `proxy_read_timeout 300s` (an idle limit between bytes, not a total duration). Headers set upstream: `Host` is `$proxy_host`, `X-Forwarded-For` is `$proxy_add_x_forwarded_for` and `X-Forwarded-Proto` is `$scheme`. The template does not set `X-Real-IP`.

The only edge rule that blocks an API path is `/api/internal`. The API's Swagger UI (`/docs`, spec at `/api-docs/openapi.json`) and `/health` are not blocked by the template.

The API applies its own per-route limits behind the edge: `/playground/chat` 32 MiB, `/playground/voice` 96 KiB, and no body limit on `/gateway/*`. The gateway's HTTP client has a 10 second connect timeout and no total timeout ([gateway](./gateway.md)).

Which routes are prerendered, and what the SPA shell serves, is described in [frontend](./frontend.md).

## API runtime

`apps/api/src/main.rs` starts in this order: read `DATABASE_URL` (required), open a Postgres pool of at most 10 connections, run the SQL migrations in `apps/api/migrations` (`sqlx::migrate!`), bind `[::]:$PORT`, build `AppConfig` from the environment (`AppConfig::from_env`, which fails startup on a missing required value), refresh stored connection metadata, then serve. Outbound HTTP uses a 10 second connect timeout and a 30 second total timeout; the gateway uses a separate client (above).

| Variable                                  | Required | Default                 | Meaning                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                            | yes      |                         | Postgres connection string                                                                                                                                                                                                                                                       |
| `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`      | yes      |                         | base64url (no padding) of exactly 32 bytes; AES-256-GCM key for stored provider credentials                                                                                                                                                                                      |
| `GEMINI_OAUTH_CLIENT_SECRET`              | yes      |                         | Client secret for the Google OAuth flow used by Gemini accounts                                                                                                                                                                                                                  |
| `PORT`                                    | no       | `8080`                  | Listen port                                                                                                                                                                                                                                                                      |
| `FRONTEND_ORIGIN`                         | no       | `http://localhost:5173` | The browser origin allowed by CORS with credentials                                                                                                                                                                                                                              |
| `COOKIE_SECURE`                           | no       | `false`                 | Adds `Secure` to session cookies; when `true`, the local-development origins are dropped from the CORS allow-list                                                                                                                                                                |
| `TRUST_PROXY_HEADERS`, `CLIENT_IP_HEADER` | no       | `false`, `x-real-ip`    | Rate-limit buckets key on the socket peer; with `TRUST_PROXY_HEADERS=true` they key on the IP in `CLIENT_IP_HEADER` instead                                                                                                                                                      |
| `TELEGRAM_SERVICE_TOKEN`                  | no       | unset                   | Shared secret for `/internal/telegram/*`; unset or blank makes every internal route return `403` ([telegram](./telegram.md))                                                                                                                                                     |
| Provider URL and version overrides        | no       | Official endpoints      | `CODEX_CLIENT_VERSION`, `CODEX_AUTH_ISSUER`, `CLAUDE_*`, `GEMINI_*` (other than `GEMINI_OAUTH_CLIENT_SECRET`), `GROK_*`, `GROQ_API_URL`, `DEEPSEEK_API_URL`, `CHATGPT_CODEX_MODELS_URL`, `CLAUDE_MODELS_URL` (read in `apps/api/src/core/config.rs`, mainly for tests and mocks) |

- **Client IP.** Behind the edge the socket peer is the proxy. With `TRUST_PROXY_HEADERS` unset every client therefore shares one rate-limit bucket. With it set, the named header must be one the proxy overwrites (the template forwards `X-Forwarded-For` and does not set `X-Real-IP`). A missing or malformed header falls into a single shared `Unknown` bucket rather than the peer. IPv4-mapped IPv6 addresses count as IPv4, and IPv6 addresses are bucketed by their first 64 bits. Limits are in-memory token buckets per process; see [accounts and pools](./accounts-and-pools.md).
- **CORS and cookies.** Allowed origins are `FRONTEND_ORIGIN` plus, only while `COOKIE_SECURE` is false, `localhost` and `127.0.0.1` on ports `5173`, `5174` and `3000`. Methods are `GET`, `POST`, `PUT` and `DELETE`; headers `Authorization` and `Content-Type`; credentials are allowed; `x-hub-connection-id` and `Retry-After` are exposed. Session cookies are always `HttpOnly; SameSite=Lax; Path=/`. A frontend on a different site cannot carry them; production works because the browser calls `/api` on the frontend's own origin.
- **Background work.** A 60 second tick runs the nightly credential check (once per Vietnam calendar day, UTC+7), expires abandoned authorization prompts and refreshes due credentials. On shutdown the sweeps stop first and in-flight refreshes get up to 25 seconds to commit, because a provider may already have rotated a refresh token. Details in [accounts and pools](./accounts-and-pools.md).
- **Endpoints for operations.** `GET /health` on the API and the Telegram adapter, `GET /healthz` on the edge.
- **Examples and smoke test.** `apps/api/examples/refresh_provider_credentials.rs` is an operator tool for the credential sweep; `apps/api/scripts/smoke-local-railway.sh` writes synthetic rows to the linked Railway database through a private tunnel and attempts to delete them on exit, so check the linked project and environment before running it.

## OpenAPI contract

The API publishes an OpenAPI document generated from its handlers (`utoipa`). `/internal/telegram/*` is deliberately excluded. `pnpm api:generate` runs the `export_openapi` binary to write `apps/api/openapi.json`, then `openapi-typescript` writes `apps/frontend/src/services/api/api.generated.ts`, then Prettier formats both. Running it is a manual step after changing a handler or a response type; nothing in CI detects a stale pair.

## Build

- **Frontend image.** Builder `node:26-bookworm-slim` with pnpm `11.10.0`. It installs from the lockfile, copies `contributors/` (the Tools catalogue sources are read at build time) and `apps/frontend`, and builds with `VITE_API_BASE_URL=/api` and `VITE_BASE_PATH=/`. The runtime stage is `nginx:1.29-alpine` with the template above and `build/client` as the web root.
- **API and Telegram images.** Builder `rust:1.98-bookworm` runs `cargo build --locked --release` for `hub-william-backend` or `hub-william-telegram`. The runtime stage is `debian:bookworm-slim` with `ca-certificates` and the one binary. The adapter build also copies `apps/telegram/assets`, because the payment QR is compiled into the binary.
- **CI toolchains differ from the images:** CI uses pnpm 10 and Node 24; the frontend image uses pnpm 11.10.0 and Node 26. Both build from the same lockfile.
- **Production secrets** stay in Railway variables: the API gets `DATABASE_URL` from the Postgres reference variable and a sealed `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`; the frontend gets only `API_INTERNAL_URL`.

## Local development

| Command             | Starts                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`          | Vite dev server for `apps/frontend`, bound to `127.0.0.1`                                                      |
| `pnpm api:dev`      | `cargo run` of `hub-william-backend`; needs a local Postgres and the variables above (`apps/api/.env.example`) |
| `pnpm telegram:dev` | `cargo run` of `hub-william-telegram` (`apps/telegram/.env.example`)                                           |

- **Choosing the API.** `VITE_API_BASE_URL` (in `apps/frontend/.env`) is the base for every API URL; it falls back to `http://localhost:8080` when unset. A local API accepts the Vite origin because local origins are allowed while `COOKIE_SECURE` is false.
- **Dev proxy.** `DEV_API_PROXY_TARGET` (read from `.env` with the `DEV_` prefix) makes the dev server proxy `/api` to that target and, for requests whose `Origin` is the dev server's own origin, rewrite `Origin` to the target's origin. Setting `VITE_API_BASE_URL=/api` together with it lets a local frontend use a deployed API behind its edge; sessions stay separate from the deployed site, and the deployed API's cookie and origin rules still apply.
- **Tests do not read `.env`.** `apps/frontend/vitest.config.ts` fixes `VITE_API_BASE_URL` to `http://localhost:8080` for the test run, whatever `.env` says.
- **Base path.** `VITE_BASE_PATH` (default `/`) sets Vite's `base` and the router `basename`; the two must agree.
- **Before a pull request** run the checks in the [CI](#continuous-integration) list that apply to the change; `.github/CONTRIBUTING.md` has the contributor-facing summary.
