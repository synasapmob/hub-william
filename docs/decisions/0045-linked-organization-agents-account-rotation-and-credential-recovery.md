# ADR-0045: Linked organization agents, account rotation and credential recovery

- Status: Accepted
- Date: 2026-09-29
- Authority: operator request of 2026-09-29. Organization "Add your existing
  account" must stay linked to the Workspace account (refresh together; deleting
  the Workspace account removes it from the organization; removing it from the
  organization keeps the Workspace account). A failing agent must rotate to
  another account and only fail once the pool is exhausted. The backend must
  refresh accounts every 30-45 minutes on its own, and accounts must stop
  dropping to "Reconnect required".
- Partially supersedes: [ADR-0010](0010-credential-aware-pool-recovery.md)
  (a single upstream `401` marks the account),
  [ADR-0013](0013-periodic-provider-credential-refresh.md) and
  [ADR-0030](0030-nightly-connected-account-credential-check.md) (60-minute
  cadence; reconnect-required accounts are never retried),
  [ADR-0022](0022-bounded-transient-gateway-retries.md) (four attempts across
  all pools), and the "pinned, never fall back" rules of
  [ADR-0025](0025-session-backed-playground.md),
  [ADR-0027](0027-organizations-and-session-agent-access.md),
  [ADR-0028](0028-gemini-forbidden-pool-failover.md),
  [ADR-0031](0031-explicit-agy-account-verification.md) and
  [ADR-0032](0032-playground-native-voice.md).

## Context

Production logs from the five API deployments between 2026-09-25 and
2026-09-29 show every hourly and nightly sweep reporting `0 need
reauthorization, 0 failed`, including more than 100 successful sweeps in one
deployment, while owners still saw accounts marked "Reconnect required". The
state came from the request path instead:

- An upstream `401` marked the account immediately. There was no refresh or
  retry, no check that the rejected access token was still the stored one, and
  no log line. A request holding a token that a sweep had just rotated could
  therefore mark a healthy account.
- Both sweeps skipped `reauth_required` rows, so one spurious mark was
  permanent until the owner pressed Refresh.
- A refresh ran inside the caller's transaction. A request timeout (the 4-second
  usage lookup), a dropped client or a SIGTERM during deploys could roll back a
  refresh after the provider had already rotated the refresh token. The next
  refresh then failed as a reused token.
- An abandoned reconnect prompt that later expired demoted an account even
  after a manual Refresh had restored it.

Organization agents were already stored as links. `organization_agents` points
at the Workspace `agent_connections` row (`ON DELETE CASCADE`) and never copies
credentials. Sharing twice, however, returned an error, and Playground requests
were pinned to one account.

## Decision

**Linked organization agents.** An organization agent is the owner's Workspace
connection: the same row, credential and availability. Refreshing or
reconnecting it on either side updates both. Deleting the Workspace connection
removes every organization link by cascade. Removing it from an organization
deletes only the link. Sharing is idempotent: a repeated or concurrent share
returns the existing link (`200`) instead of an error. The owner can refresh a
linked agent from the organization view through the existing owner-only
connection refresh.

**Rejected credentials.** On an upstream `401` (and Grok `403`), the gateway
calls a refresh under the credential row lock, but only when the rejected token
is still stored. Otherwise it takes the token another request already rotated
in, and retries the same account once. That retry does not spend the attempt
budget. The account is marked for reconnect only in two cases: the provider
rejects the refresh credential, or it also rejects the fresh token. That second
mark is compare-and-set against the observed token and logged. A transient
refresh failure moves on to the next account without marking. Concurrent
requests that all hit `401` share one refresh.

**Account rotation.** A browser request's selected account is the preferred
account. It is tried first, and the rest of the same provider's accounts in the
same scope stay available for failover:

- Personal scope: the user's own accounts and accepted pools.
- Organization scope: only that organization's shares.

The scopes never mix. Key clients keep the same scoped candidate set. Each
account gets at least one attempt, so the budget is `max(4, accounts)`. The
request fails only once every account in scope is rate limited, needs
reconnect, or refused. Accounts are rotated on `429`, `401` after recovery, a
non-Gemini `403`, a `402` (for example a DeepSeek account without balance), and
transient `5xx`, `408` or network failures. `400`-class
request errors are returned without rotation. A successful browser response
names the serving account in `x-hub-connection-id` (exposed through CORS for
development). Failover still happens only before streaming starts; partial
streams are never replayed. ChatGPT voice rotates only on explicit refusals,
because a lost session answer is never replayed; an account whose credential
cannot be read or refreshed is skipped before any session request. Groq voice
starts on the first usable account and does not switch accounts mid-turn; a
rejected voice call revalidates the key and marks the account only if the key
itself is rejected.

**Refresh cadence and recovery.** Every minute, the API rotates each connected
OAuth credential once it has gone 30 minutes plus a stable per-account offset of
0-15 minutes without a refresh. Each account therefore refreshes every 30-45
minutes whether or not it is used, and accounts do not all refresh together.
The nightly check stays in place for static API keys.

The same sweep retries reconnect states that do not prove the refresh credential
is dead: gateway rejections, and expired reconnect prompts with no pending
authorization. A successful refresh restores the account to active and clears
obsolete prompts. A rejected refresh changes the message to "authorization
expired", which stops further retries. Verification challenges and owner-started
reconnects are never auto-restored.

**Operational safety.**

- Request traffic reads credentials without a row lock unless the token is
  within five minutes of expiry, so members sharing one account do not queue
  behind a background refresh.
- Every refresh runs in its own task, so cancelling the caller cannot roll back
  a rotated token.
- On SIGTERM, the API immediately stops scheduled sweeps from starting another
  account, drains open requests, and then waits up to 25 seconds for refreshes
  already talking to a provider to commit before exiting.
- Deleting a Workspace connection takes the credential lock first, the same
  order refreshes use, so a delete waits for an in-flight refresh instead of
  deadlocking with it.

## Consequences

- One stale or early-expired access token no longer marks an account for
  reconnect. Accounts that were already marked by the old gateway path recover
  automatically within 30-45 minutes if their refresh credential still works.
- Each OAuth account refreshes about 32-48 times per day instead of 24.
- An account whose refresh works but whose fresh tokens are always rejected is
  retried once per interval, and requests fail over around it meanwhile.
- Users can be answered by a different account than the one they selected,
  within the same scope. The Playground shows which account answered.
- Failover cannot rescue a stream that has already started.
- The graceful shutdown helps only when the platform allows a drain period
  after SIGTERM.
