# ADR-0028: Gemini forbidden pool failover

## Status

Accepted — 2026-09-24. Supersedes ADR-0022's return-immediately rule for an
upstream Gemini Code Assist `403` before response headers reach the client.

## Context

One Google Code Assist account can reject an AGY generation or token-count
request with `403` while another accessible Gemini pool can serve it. The
gateway already advances on provider `401`, `429`, and bounded transient
failures, but it returned Gemini generation or token-count `403` immediately
and marked the rejected account active. Model discovery already tried another
pool after a non-success response.

A `403` alone does not prove that OAuth renewal is the remedy: access can also
depend on account, project, or model entitlement. A malformed request should
remain visible to the caller rather than be hidden by account rotation.

## Decision

- For gateway-key Gemini generation and token-count requests, an upstream
  `403` before the response is returned advances to the next authorized Gemini
  pool within the existing four-attempt budget. It does not retry that same
  candidate, mark it active, start OAuth reauthorization, or persist a cooldown
  solely because of `403`.
- If no candidate succeeds, return the final Gemini `403` response when no
  higher-priority rate-limit or reauthorization outcome applies.
- Preserve the existing `401` reauthorization, `429` cooldown, bounded
  transient retry, and terminal `400` behavior. No request crosses providers
  or resumes on another pool after streaming has started.
- Playground requests remain pinned to the account explicitly selected by the
  user under ADR-0025 and ADR-0027. A pinned request can return `403` but
  cannot silently consume a different account.

## Consequences

An account-specific AGY block no longer stops installed gateway-key clients
while another accessible Gemini pool is available. A blocked pool may be tried
again on a later request because `403` alone does not justify a persistent
credential-state change. Owners still use the existing reconnect flow for a
pool that needs login.
