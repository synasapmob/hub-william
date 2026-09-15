# ADR-0022: Bounded transient gateway retries

## Status

Accepted — 2026-09-15. Supersedes ADR-0006's rule that every upstream response
other than `401` and `429` returns immediately, and ADR-0007's rule that every
non-`429` response restores a half-open pool to `active`, for the transient
statuses named below.

## Context

OMP exposes the first upstream `5xx` returned by a provider adapter, while some
official agent clients retry the same transient failure internally. As a
result, an otherwise healthy Gemini, Codex, Claude, Grok, or DeepSeek account
can appear less reliable through OMP even when a second attempt would succeed.

The gateway can retry only before it returns the upstream response. Once a
stream has started, joining a new generation onto the partial response would
corrupt the provider protocol. Retrying generation requests also has an
at-least-once trade-off: an upstream may have consumed quota before its edge
returned an error, so retries must remain tightly bounded.

## Decision

- Treat upstream HTTP `408`, `500`, `502`, `503`, and `504`, plus network
  failures before response headers, as transient gateway attempts.
- Allow at most four upstream attempts for one incoming gateway request across
  all authorized pools combined. Retry one candidate before moving on when the
  budget can still preserve an attempt for each remaining candidate; let the
  final candidate consume any remaining budget.
- Delay transient retries with exponential backoff starting at 500 ms, then 1
  second and 2 seconds, with 20 percent jitter and a two-second per-delay cap.
  Honor an integer-seconds `Retry-After` value within that same cap.
- Apply the policy to the shared Codex, Claude, Grok, and DeepSeek proxy, Gemini
  generation and token-count requests, and Gemini model discovery.
- Keep the existing `401` reauthorization, Grok `403` reauthorization, and
  `429` cooldown/failover behavior. Client errors outside those explicit auth
  rules return without transient retry.
- Never retry after a response has been handed to the streaming body. A
  mid-stream transport failure remains visible to the client so it can restart
  the turn without mixing two generations.
- Do not restore a half-open connection to `active` after a transient failure.
  Release its probe when moving to another pool or returning the final failure;
  a non-transient upstream response continues to restore it.
- If the global attempt budget is exhausted, return the final upstream HTTP
  response when available. If every attempt failed before response headers,
  return the existing provider-unavailable gateway error.

## Consequences

- Short provider-edge failures are usually absorbed before OMP sees them, with
  at most 3.5 seconds of nominal backoff beyond upstream response time.
- Multiple pools cannot multiply the retry count because they share one global
  attempt budget.
- A retried generation may consume upstream quota more than once. The bounded
  budget accepts that risk in exchange for interactive reliability; the
  gateway does not claim exactly-once generation semantics.
- Partial streams remain explicit failures and continue to rely on each agent
  client's native recovery behavior.
