# ADR-0007: Pool cooldown and owner membership controls

- Status: Accepted
- Date: 2026-09-10
- Supersedes: ADR-0006 rate-limit availability handling only

## Context

Retrying a provider account on every gateway request after it has returned HTTP
`429` adds latency, increases unnecessary provider traffic, and can make account
enforcement more likely. Pool owners also need to grant and revoke access
without requiring every member to submit a join request first.

Account labels are public pool metadata. Their previous mask kept the complete
email domain visible, which exposed more identity information than discovery
requires.

## Decision

- An upstream `429` persists the connected account as `rate_limited` for 30
  minutes. Ordinary gateway selection skips it during that window and continues
  only through accessible pools for the same provider.
- The first real gateway request after the retry time atomically claims that
  pool as a half-open probe. A non-`429` upstream response restores `active`; a
  new `429` starts another 30-minute cooldown. Failed credential or network
  preparation releases the probe without falsely marking the pool active.
- No synthetic prompt or background provider request is generated. A manual
  owner refresh clears the wait and arms that exact pool for the next real
  gateway request. The same half-open claim prevents concurrent probe spam.
- A pool owner may invite an existing Hub username directly. Direct invites use
  the existing accepted join record as the single membership and gateway
  authorization boundary. Removing that accepted record kicks the member and
  revokes access to that pool immediately.
- Public connected-account labels expose only the first three local-part
  characters and the final domain suffix, for example `102**@**.com`.

## Consequences

- Rate-limited pools stop adding avoidable upstream attempts during cooldown,
  while same-provider failover remains available.
- Retry recovery is driven by real user traffic, so no separate cron service is
  required. A pool can remain unavailable after its timer until a matching
  gateway request or owner refresh occurs.
- Owners can manage the full membership lifecycle from the request dialog, and
  gateway candidate authorization stays consistent with that UI.
- Existing stored public labels are backfilled to the shorter mask during the
  schema migration.
