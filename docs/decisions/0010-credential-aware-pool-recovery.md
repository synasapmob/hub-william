# ADR-0010: Credential-aware pool recovery

- Status: Accepted
- Date: 2026-09-14
- Supersedes: ADR-0006 upstream authentication failure handling and ADR-0007 owner refresh behavior only

## Context

A gateway request may have access to several authorized account pools for the
same provider. Returning the first upstream `401` breaks the caller even when a
later pool still has a valid provider session. Treating that response as proof
that the pool is active also sends every later request back to the same invalid
credential.

The pool availability control currently clears a rate-limit wait but does not
refresh the provider credential. Pool owners need one recovery action that uses
the stored refresh token when possible and falls back to the provider's
official authorization flow when that provider session can no longer refresh.

## Decision

- An upstream provider `401` marks that connection as `reauth_required` and
  advances the current gateway request to the next accessible pool for the
  same provider. Hub gateway-key authentication failures remain terminal and
  are never retried against provider pools.
- Gateway routing continues until a candidate returns a response other than
  `401` or `429`, or until every same-provider candidate is unavailable.
- `reauth_required` connections stay visible to their owner and members but are
  skipped by ordinary gateway selection until the owner recovers them.
- Pool `Refresh` forces a provider credential refresh even when the stored
  access-token expiry is not near. A successful refresh stores the latest token
  response and restores the connection to `active`.
- A missing, expired, or provider-rejected refresh token starts a new official
  authorization attempt for the same connection record. Successful
  reauthorization replaces the encrypted credential and restores `active`
  without changing the pool identifier or its memberships.
- Transient provider and network failures remain explicit errors and do not
  discard the current credential or silently start a login flow.

## Consequences

- One broken provider session no longer interrupts a request while another
  authorized same-provider pool is usable.
- Reauthorization preserves pool membership because recovery updates the
  existing connection instead of creating a replacement pool.
- Owners may refresh an active pool on demand, and users can distinguish a
  rate-limit cooldown from an account that needs provider login.
