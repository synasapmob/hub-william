# ADR-0013: Periodic provider credential refresh

- Status: Accepted
- Date: 2026-09-15

## Context

Gateway requests already refresh a provider credential shortly before its
access token expires. That protects active traffic, but a connected pool that
receives no traffic can keep the same provider refresh token until it becomes
too old to rotate. Pool owners should not need to refresh every account by
hand to keep an otherwise valid provider session current.

## Decision

- The API scans connected pool credentials once per minute and refreshes each
  credential after it has remained unchanged for 60 minutes.
- The 60-minute eligibility check is repeated while holding the credential row
  lock. Concurrent API replicas therefore cannot rotate the same refresh token
  twice during one refresh window.
- A scheduled refresh preserves pool rate-limit state. The manual pool refresh
  remains the explicit action that clears availability failures after a
  successful credential refresh.
- A rejected, expired, or missing refresh token marks only that connection as
  requiring reauthorization. The remaining pool credentials continue through
  the sweep, while the owner can use the existing Refresh action to start the
  official provider authorization flow.
- Transient provider, network, and per-connection database failures are logged
  without stopping later credentials or the next scheduled sweep. A failed
  provider attempt is not retried until the account's next 60-minute window.

## Consequences

- Connected provider sessions rotate in the background even when no gateway
  request currently uses them.
- A provider outage may make one scheduled sweep partially fail, but request
  traffic can still use the existing credential until its actual access expiry
  and later sweeps retry it.
- The scheduler is safe to run in more than one API replica because refresh
  eligibility and token rotation share the existing database row lock.
