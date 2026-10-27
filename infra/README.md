# Infrastructure

Production runs four Railway services. Staging deploys `api` and `frontend`
(the `telegram` adapter has no staging deployment). Pipelines, edge rules and
runtime configuration are described in
[docs/architecture/deployment.md](../docs/architecture/deployment.md).

- `frontend` is the only public service for the web app. Nginx serves the
  prerendered build and proxies same-origin `/api/*` traffic over Railway
  private networking. `/api/internal` and `/api/internal/*` return `404` at the
  edge.
- `api` has no public domain, listens on IPv6, and receives traffic at its
  `*.railway.internal` hostname from the frontend service.
- `telegram` has its own public HTTPS Railway domain for webhooks and the payment
  QR image: `POST /webhook` from Telegram (verified with the webhook secret),
  `POST /sepay` from SePay (verified with `Authorization: Apikey`) and
  `GET /qr.png`, which Telegram fetches as a photo. It calls
  `api` over Railway private networking with a separate service token; it does
  not expose the API to the internet.
- `Postgres` stores users, rotating sessions, encrypted provider connections,
  gateway key hashes, pools, join requests, membership decisions,
  organizations and their usage events, and the Telegram shop (contacts,
  catalogue, orders, payments, restocks).
- Provider-bound gateway traffic leaves through the API's gateway module. The
  `/api/gateway/*` proxy and the private `/gateway/*` router impose no
  Hub-owned request-size, token, or total response-duration budget; other API
  routes keep their body limits. The gateway's HTTP client has a connect
  timeout, and nginx applies a 300-second idle read timeout between bytes.

`apps/frontend/Dockerfile`, `apps/api/Dockerfile` and `apps/telegram/Dockerfile`
own reproducible service builds. Production secrets stay in Railway variables.
The API receives `DATABASE_URL` from the Postgres reference variable and a
sealed `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`; the frontend receives only
`API_INTERNAL_URL`, the API's private origin.
