# Infrastructure

The target production topology has four Railway services:

- `frontend` is the only public service. Nginx serves the prerendered build and
  proxies same-origin `/api/*` traffic over Railway private networking.
- `api` has no public domain, listens on IPv6, and receives traffic at its
  `*.railway.internal` hostname from the frontend service.
- `telegram` has its own public HTTPS Railway domain solely for Telegram
  webhooks. It verifies Telegram's webhook secret and calls `api` over Railway
  private networking with a separate service token; it does not expose the API
  to the internet.
- `Postgres` stores users, rotating sessions, encrypted provider connections,
  gateway key hashes, pools, join requests, membership decisions, and Telegram
  contact records.
- SePay will need an authenticated public webhook boundary when payment
  delivery is explicitly designed; Telegram webhooks are owned by `telegram`.
- Provider-bound gateway traffic will leave through the API's gateway module.

`apps/frontend/Dockerfile` and `apps/api/Dockerfile` own reproducible service builds.
Production secrets stay in Railway variables. The API receives
`DATABASE_URL` from the Postgres reference variable and a sealed
`PROVIDER_CREDENTIAL_ENCRYPTION_KEY`; the frontend receives only
`API_INTERNAL_URL`, the API's private origin.
