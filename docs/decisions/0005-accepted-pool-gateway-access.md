# ADR-0005: Accepted pool membership grants gateway access

- Status: Accepted; gateway-account selection superseded by ADR-0006
- Date: 2026-09-10
- Supersedes: ADR-0003 gateway-account selection only

## Context

ADR-0003 scoped gateway keys to accounts connected by the key owner. That made
join requests and owner acceptance durable, but an accepted member still could
not use the shared account through the gateway. The product purpose is account
pool sharing, so acceptance must be an authorization boundary rather than only
a presentation state.

One Hub key configures multiple local agent clients. A user may also own an
account and belong to another accepted pool for the same provider, so account
selection must remain deterministic without exposing provider credentials or
adding an account picker to the approved UI.

## Decision

- A user may create a gateway key when they own at least one connected account
  or have at least one accepted pool membership.
- Gateway provider lookup includes owned connected accounts and accepted pool
  memberships. It prefers the user's own account; otherwise it selects the
  most recently accepted matching membership.
- Pending and rejected requests grant no gateway access. Changing an accepted
  request to rejected removes access immediately without rotating every key.
- Gateway keys remain user-scoped, hash-only at rest, revocable, and unable to
  route through providers outside the user's current owned-or-accepted set.

## Consequences

- Owner acceptance now makes the shared provider usable by the accepted member
  through their own Hub gateway key.
- A membership decision is security-sensitive and remains protected by both a
  Hub session and the database-checked connection owner.
- A future account picker can replace the fallback ordering without changing
  key format or exposing provider tokens to the browser.
