# ADR-0001: Monorepo application boundaries

- Status: Superseded by ADR-0008
- Date: 2026-09-09

## Context

Hub William began as a static React catalogue backed by repository-owned
Markdown and a machine installer. The product is expanding toward shared agent
pools, SePay-confirmed orders, issued gateway keys, provider proxying, and a
later Telegram interface. Those capabilities need a trusted runtime without
putting credentials or payment authority in browser code.

## Decision

The repository is organized into these ownership boundaries:

- `apps/frontend/` owns the current React application, frontend documentation,
  public assets, build tooling, and the existing machine installer scripts.
- `apps/api/` owns the Rust HTTP runtime, generated OpenAPI source, future
  PostgreSQL access, pool and order rules, access-key issuance, gateway
  routing, and third-party integrations.
- `infra/` will own provider-specific deployment configuration only when a
  real deployment consumes it.
- `docs/decisions/` records decisions that apply to the whole monorepo.
- `contributors/` remains the repository-owned catalogue consumed by the
  frontend and machine installer.

The backend's Rust DTOs and routes are the source of truth for OpenAPI. The
frontend will generate its TypeScript client from that schema; no separate
contracts package is created.

Telegram is an HTTP integration inside the backend. Telegram sends updates to
an authenticated backend webhook, and the backend calls the Telegram Bot API
to respond. A separate Telegram service is justified only by later scaling,
background-work, or failure-isolation evidence.

The initial backend is deliberately limited to health and OpenAPI endpoints.
This bootstrap does not claim to implement pools, SePay, database persistence,
gateway authentication, provider routing, or Telegram behavior.

## Consequences

- Frontend and backend can deploy independently while changing atomically in
  one repository.
- Existing root developer commands continue to orchestrate both applications.
- Frontend builds must explicitly read the root `contributors/` catalogue.
- Machine-installer sparse checkouts must include `apps/frontend/scripts/` and
  `contributors/`.
- Browser code never owns SePay, Telegram, database, gateway, or upstream
  provider secrets.
- Railway and PostgreSQL configuration remain deferred until the first backend
  deployment, avoiding unused infrastructure manifests.
