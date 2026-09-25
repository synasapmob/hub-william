# ADR-0031: Explicit AGY account verification challenge

- Status: Accepted
- Date: 2026-09-25
- Extends: ADR-0028's Gemini `403` pool failover and ADR-0030's operator refresh

## Context

A Google OAuth refresh can succeed while Code Assist still rejects AGY requests
with `403` and the explicit message `Verify your account to continue.` The
generic `403` rule in ADR-0028 correctly tries another pool because status
alone does not prove that a login will fix an account, project or model denial.
It also leaves this specific verification-blocked account active, so the same
pool can keep being retried and the owner sees no reconnect state.

## Decision

- Inspect a bounded prefix of a Gemini Code Assist `403` error response. Only an
  explicit account-verification message marks that pool `reauth_required` and
  asks its owner to reconnect. Keep generic `403` as next-pool failover without
  changing the account state. Preserve the original generic error response for
  the caller if no alternate pool succeeds, and never log provider bodies.
- Apply this distinction to model discovery, generation and token counting.
  Before marking an observed challenge, lock and compare the stored access token
  so a fresh login cannot be overwritten by a response from an older request.
  A later success or rate-limit response already in flight cannot clear the
  reconnect state; only a confirmed forced check or completed login can.
- A forced credential refresh, including the operator all-account command,
  rotates Gemini OAuth tokens and then probes Code Assist model discovery,
  token counting and one minimal generation request. A verification challenge marks the connection
  for reauthorization in the same credential transaction. An inconclusive probe
  does not clear a previously red account or prove an expired login; only a
  successful Code Assist token-count probe restores it. The existing hourly and nightly
  scheduled sweeps retain their OAuth freshness behavior.

## Consequences

Owners see verification-blocked AGY accounts in the existing red reconnect
state. Gateway-key clients can continue on another eligible Gemini pool; a
browser Playground request remains pinned to its selected account. An
inconclusive probe cannot guarantee that a later model-specific
generation will work; the gateway classifies the explicit challenge if it
appears on that later request.
