# ADR-0014: Google OAuth Gemini subscription gateway

- Status: Accepted
- Date: 2026-09-15

## Context

Hub William already connects subscription-backed ChatGPT, Claude and Grok
accounts, then gives local agent CLIs a revocable Hub gateway key. AGY supports
Google-account OAuth for Gemini subscriptions, but its custom base URL mode uses
the native Gemini Developer API protocol and expects an API key.

Using a separate Gemini Developer API key would bypass the subscription account
the operator explicitly wants to share through Hub William.

## Decision

- Add Gemini as a provider connected with the public AGY Google OAuth client,
  PKCE, offline access and the official Google Code Assist scopes.
- Store Google access and refresh tokens only in the existing encrypted provider
  credential store. Resolve the masked account email, subscription tier and
  Code Assist project during connection.
- Expose a native Gemini-compatible gateway under `/gateway/gemini/v1beta`.
  Authenticate AGY's incoming `x-goog-api-key` with a revocable Hub key, wrap
  requests for the Google Code Assist API, authenticate upstream with the stored
  Google OAuth token, and unwrap responses back to native Gemini protocol.
- Configure AGY in direct Gemini mode with `GEMINI_API_KEY` set to the Hub key
  and `GOOGLE_GEMINI_BASE_URL` set to the Hub Gemini gateway. The Hub key is not
  forwarded to Google.
- Preserve the existing provider-scoped pool selection, share enforcement,
  refresh, cooldown and reauthorization behavior.

## Consequences

- A paid Google Gemini subscription can back AGY through Hub William without a
  separate billable Gemini Developer API key.
- The bridge depends on Google Code Assist's subscription protocol as used by
  AGY, not the public API-key quota contract.
- OAuth client identity and Google endpoints remain environment-overridable so
  provider rollouts can be handled without exposing upstream tokens to the
  browser or local agent configuration.
