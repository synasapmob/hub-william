# ADR-0050: Stored credential refresh schedule and transient retries

- Status: Accepted
- Date: 2026-10-20
- Authority: operator request of 2026-10-20 after a Claude account returned to
  "Reconnect required": scheduled refresh must retry at least twice when the
  network or provider fails, must fail at once when the token is really
  expired, and must refresh every 30 minutes from a stored `next_refresh_at`
  instead of a random 30-45 minute spread.
- Partially supersedes: the per-account 30-45 minute spread and the rule that a
  failed provider attempt waits for the account's next window in
  [ADR-0045](0045-linked-organization-agents-account-rotation-and-credential-recovery.md)
  and [ADR-0013](0013-periodic-provider-credential-refresh.md).

## Context

Production on 2026-10-20 showed one connected Claude account `reauth_required`.
The API log held a single line for it, at 03:56:42 UTC, saying the provider
rejected its stored refresh credential during a scheduled refresh. The stored
row said otherwise:

- the last rotation succeeded at 03:15:41 UTC;
- Anthropic had reported that refresh token would expire at 03:42:12 UTC, 26.5
  minutes later, which the operator attributes to the subscription ending;
- the next scheduled attempt, 41 minutes after the rotation, ran at 03:56:41
  UTC, fourteen minutes after that expiry.

`refresh_connected_connection` compared `refresh_token_expires_at` with the
clock before it called the provider. The provider was never asked. The log line
named the wrong cause because the same message was printed for every
reconnect-required outcome.

Claude is the only provider whose token response carries
`refresh_token_expires_in`. The ChatGPT, Gemini and Grok rows in production have
no stored refresh-token expiry, so for them a dead refresh token is only
discovered when the provider rejects it.

Two further properties of the old schedule mattered:

- The schedule was derived twice, in Rust (`scheduled_refresh_after`) and in the
  sweep's SQL, with a comment requiring them to match.
- A provider outage during a scheduled refresh cost a whole interval
  (30-45 minutes) before the next attempt, which is longer than some refresh
  tokens live.

## Decision

- Each credential row stores `next_refresh_at` and `refresh_failure_count`. The
  sweep selects rows with `next_refresh_at <= NOW()`; the same comparison is
  repeated under the credential row lock, so API replicas still cannot rotate
  one refresh token twice. The Rust and SQL formulas are removed.
- A successful refresh, and a new or reconnected credential, sets
  `next_refresh_at` to exactly 30 minutes ahead and clears the failure count.
  Accounts keep the spread of the moments they were connected, because each
  schedule is relative to that account's own last refresh. The migration
  backfills existing rows from the old per-account schedule once, so deploying
  does not make every account due together.
- If the provider reports that the refresh token expires before the next
  regular time, the account is scheduled five minutes before that expiry, and
  never sooner than one minute ahead. An expiry that is already in the past is
  ignored. A provider that renews the lifetime, for example when a subscription
  renews, is therefore asked before the old one ends.
- The stored refresh-token expiry no longer marks an account for reconnect. The
  provider is always asked, and only its rejection (`invalid_grant`, or the
  ChatGPT `refresh_token_invalidated` code) or a missing refresh token marks the
  account. A rejected token fails at once and is not retried.
- A scheduled refresh that fails on the network, a timeout, a malformed success
  response, `408`, `429` or any `5xx` is transient. It is retried after one
  minute and then after five minutes: two retries, three attempts in all. After
  the third failure the count resets and the account waits for the next regular
  refresh. A transient failure never marks an account for reconnect, because the
  token was not shown to be bad. Other `4xx` answers are not retried early and
  wait for the regular refresh.
- A request-time refresh (access token near expiry, or rejected by the
  provider) does not use the retry schedule; its caller already handles the
  failure.
- The reconnect-required log line no longer claims the provider rejected the
  credential, since several causes share it.

## Consequences

- A short provider or network outage no longer costs a regular interval, and
  no longer leaves an expiring refresh token unrefreshed.
- A refresh token that really has expired is rejected by the provider on the
  next scheduled attempt, which marks the account exactly as before. It costs
  one extra provider request per such account.
- A transient failure that happens after the provider has already rotated the
  refresh token cannot be told apart from an outage. Providers that make
  refresh tokens single-use then answer the retry with `invalid_grant`, and the
  account needs its owner. Retrying cannot repair this case.
- The reason an account needs reconnecting is still only a free-text message.
  Recording it as a structured reason with an audit trail is a separate change.
