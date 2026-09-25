# ADR-0030: Nightly connected-account credential check

- Status: Accepted
- Date: 2026-09-25
- Extends: ADR-0013's hourly OAuth refresh
- Partially supersedes: ADR-0015's manual-only DeepSeek key validation

## Context

The API already rotates connected OAuth credentials after 60 minutes without a
refresh. That keeps inactive ChatGPT/Codex, Claude, Gemini/AGY and Grok pools
current, but there is no daily boundary check for every connected provider.
DeepSeek uses a static API key and cannot rotate an OAuth token.

## Decision

- Keep the hourly OAuth sweep and the near-expiry refresh on gateway requests.
  A once-daily sweep alone would allow short-lived access tokens to expire
  between nights.
- At approximately 00:00 `Asia/Ho_Chi_Minh` (17:00 UTC), the API checks every
  connected, usable credential. OAuth credentials not already refreshed since
  that local midnight are rotated; DeepSeek API keys are validated against its
  model endpoint. A newly connected or already-refreshed credential is skipped.
- The first sweep after an API restart also catches up credentials that have not
  been checked since the current local midnight. A credential row lock and a
  recheck of its last refresh or validation attempt make concurrent API replicas
  skip work another replica completed. No extra Railway cron service is needed.
- An expired, rejected or missing OAuth refresh token, or a rejected DeepSeek
  key, marks only that connection for reauthorization. No background job starts
  an interactive login. Transient failures remain available for normal gateway
  use and do not stop the remaining accounts. Scheduled checks preserve pool
  cooldown and availability state; manual refresh remains the explicit action
  that can restore it. Reauthorization state and attempted-check timestamps are
  committed while holding the credential lock, so a later successful reconnect
  cannot be overwritten by an older sweep and replicas do not repeat failed
  checks in the same window.

## Consequences

The nightly sweep makes one best-effort pass across connected providers while
the existing hourly sweep continues protecting OAuth sessions throughout the
day. Accounts requiring reauthorization need their owner to reconnect them;
automatic refresh cannot renew revoked credentials or static API keys.
