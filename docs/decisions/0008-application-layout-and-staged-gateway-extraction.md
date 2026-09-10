# ADR-0008: Application layout and staged gateway extraction

- Status: Accepted
- Date: 2026-09-10
- Supersedes: ADR-0001

## Context

Hub William has a browser application and a Rust runtime that currently owns
both control-plane operations and latency-sensitive provider streaming. The
repository needs explicit application ownership now, without prematurely
creating a second gateway process before a service boundary and its operations
are implemented.

## Decision

- Deployable applications live below `apps/`.
- `apps/frontend/` owns the React application, public assets, generated
  TypeScript API client, build tooling, and machine-installer source.
- `apps/api/` owns the Rust business API: browser auth, provider-connection
  lifecycle, pools, memberships, gateway keys, orders and payments.
- `apps/api/src/gateway.rs` remains an API module for this phase. It owns
  Gateway Key authentication, provider-specific candidate selection, token
  refresh, upstream streaming, provider-scoped failover, and cooldown writes.
- A future `apps/gateway/` service extracts that module only with an explicit
  internal contract and shared Rust crates for database access and provider
  clients. The extraction must not put an API-to-Gateway HTTP hop in every
  prompt path.
- A future `apps/telegram/` service is created when Telegram commerce is
  delivered. It is an adapter that calls the business API for orders,
  entitlements, memberships, and payment state; it does not duplicate those
  business rules.
- `apps/worker/` is deferred until retry, expiration, notification, or other
  asynchronous workloads need an independently operated worker.

## Consequences

- The present deployment remains frontend plus a private API service and
  PostgreSQL, preserving existing runtime behavior.
- Root scripts, Dockerfiles, CI, Vercel configuration, GitHub Pages publishing,
  the OpenAPI generation command, and installer sparse-checkout paths use the
  `apps/` layout.
- `apps/api` is the current source of truth for business state. The in-process
  gateway may directly use the restricted database/provider layer on the hot
  path, while membership, ownership, order, and key lifecycle mutations remain
  business-API responsibilities.
- Earlier records that say "backend" refer to the Rust service now located at
  `apps/api/`; ADR-0004's public-frontend/private-Rust-service network boundary
  remains unchanged.
