# Infrastructure

Production runs as three Railway services:

- `frontend` is the only public service. Nginx serves the prerendered build and
  proxies same-origin `/api/*` traffic over Railway private networking.
- `backend` has no public domain, listens on IPv6, and receives traffic at its
  `*.railway.internal` hostname from the frontend service.
- `Postgres` stores users, rotating sessions, encrypted provider connections,
  gateway key hashes, pools, join requests, and membership decisions.
- SePay and Telegram will call authenticated HTTP webhooks on the backend.
- Provider-bound gateway traffic will leave through the backend runtime.

`Dockerfile.frontend` and `Dockerfile.backend` own reproducible service builds.
Production secrets stay in Railway variables. The backend receives
`DATABASE_URL` from the Postgres reference variable and a sealed
`PROVIDER_CREDENTIAL_ENCRYPTION_KEY`; the frontend receives only the backend's
private origin.
