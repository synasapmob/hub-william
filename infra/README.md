# Infrastructure

Production runs as three Railway services:

- `frontend` is the only public service. Nginx serves the prerendered build and
  proxies same-origin `/api/*` traffic over Railway private networking.
- `api` has no public domain, listens on IPv6, and receives traffic at its
  `*.railway.internal` hostname from the frontend service.
- `Postgres` stores users, rotating sessions, encrypted provider connections,
  gateway key hashes, pools, join requests, and membership decisions.
- SePay and Telegram will call authenticated HTTP webhooks on the API.
- Provider-bound gateway traffic will leave through the API's gateway module.

`apps/frontend/Dockerfile` and `apps/api/Dockerfile` own reproducible service builds.
Production secrets stay in Railway variables. The API receives
`DATABASE_URL` from the Postgres reference variable and a sealed
`PROVIDER_CREDENTIAL_ENCRYPTION_KEY`; the frontend receives only
`API_INTERNAL_URL`, the API's private origin.
