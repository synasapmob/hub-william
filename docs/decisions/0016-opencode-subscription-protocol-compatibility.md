# ADR-0016: OpenCode subscription protocol compatibility

- Status: Accepted; AGY catalogue discovery superseded by ADR-0018
- Date: 2026-09-15
- Supersedes: ADR-0012 Grok OAuth scope list only

## Context

OpenCode drives the Hub gateway through provider SDKs rather than the native
Codex, Antigravity, or Grok Build request builders. Those SDKs can produce a
different wire shape: the OpenAI SDK adds `max_output_tokens`, AGY discovery
can encounter one unavailable model before another usable one, and the current
Grok Build subscription contract requires scopes and request metadata that the
older Hub integration did not send.

The resulting failures are observable: Codex rejects an unsupported output
limit, one failed AGY probe hides the entire Gemini provider, and Grok returns
HTTP 403 even when the same account is entitled through the official CLI.

## Decision

- Remove only the top-level `max_output_tokens` field before forwarding an
  OpenCode Responses request to the ChatGPT Codex subscription endpoint. Keep
  the remaining request body unchanged.
- Probe the local `agy models` catalogue in order until one model passes the
  non-generating Gemini `countTokens` check. Omit the provider only after every
  candidate fails, and print the omission reason during installation.
- Request the current Grok Build OAuth scopes, including `grok-cli:access` and
  conversation/workspace read-write access. Existing tokens cannot acquire
  expanded authorization through refresh and must reconnect once.
- Use Grok Build's authenticated `/models-v2` catalogue and Responses route for
  OpenCode. Send the subscription authentication, truthful Hub client identity,
  current compatibility version, headless mode, and per-request model/affinity
  headers. A Grok HTTP 403 marks the pool for reauthorization instead of
  leaving an unusable connection active.

## Consequences

- OpenCode can use the Codex subscription route without depending on a future
  upstream `max_output_tokens` implementation.
- A transient or model-specific AGY probe failure no longer hides other usable
  models, while the installer still refuses to advertise an unreachable pool.
- Grok model IDs follow the authenticated subscription catalogue instead of a
  stale hard-coded alias. Previously connected Grok pools need one explicit
  reconnect after deployment; a genuinely unentitled account continues to
  fail rather than falling back to paid API-key quota.
