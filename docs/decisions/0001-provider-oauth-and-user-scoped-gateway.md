# ADR-0001: Provider credentials stay on the server; Hub keys identify users

- Status: Accepted
- Date: 2026-09-10, revised 2026-10-27 to describe current behaviour

## Context

A signed-in user connects their own ChatGPT, Claude, Gemini, Grok, DeepSeek or
Groq account from the web and points local agents at one gateway. The provider
password stays on the provider's page, and the bearer credentials that come
back from an authorization-code or device grant must not reach the browser after
the exchange.

The installer asks for one Hub key for any combination of agents, so the key
identifies a user, not a provider connection. The requested gateway path
selects the provider.

## Decision

- Browsing pools and the Tools catalogue is public. Join requests, provider
  connections and gateway-key management need a session; login and registration
  create one.
- Browser authentication is a `hub_session` cookie valid for five hours plus a
  rotating `hub_refresh` cookie valid for seven days. Only SHA-256 hashes are
  stored, and each refresh replaces both (`apps/api/src/api/auth/mod.rs`).
- Connect Agent asks the backend to begin the provider's device or PKCE flow and
  opens the authorization URL the backend returns: built from configured
  endpoints for ChatGPT, Claude and Gemini, and origin-checked against the issuer
  for Grok. The backend performs the code exchange; the browser never receives
  the resulting tokens.
- Provider credentials and pending authorization state are encrypted with
  AES-256-GCM before they reach PostgreSQL. The key comes from the environment
  (`PROVIDER_CREDENTIAL_ENCRYPTION_KEY`), never from the database.
- A Hub key is `hw_live_` plus 32 random bytes, shown once. PostgreSQL stores a
  SHA-256 hash and the last four characters. Keys can be listed and revoked.
- A Hub key reaches only accounts its user owns or has been accepted into. A key
  cannot route to a provider the user has no account for.
- Installers write the Hub key into the selected agents' own configuration,
  because unattended clients need it. They preserve unrelated settings, keep a
  one-time backup and write atomically with owner-only permissions.
- Provider failures stay explicit. The service never replaces one with a mock
  success.

## Consequences

- Production needs HTTPS, a strong encryption key, an exact CORS origin
  (`FRONTEND_ORIGIN`), `COOKIE_SECURE`, and a procedure to rotate or revoke
  secrets.
- A leaked database exposes neither Hub-key plaintext nor provider tokens. A
  compromised application host that holds the encryption key can decrypt
  provider credentials, and a compromised user machine can read its installed
  Hub key.
- Connected bearer and refresh tokens are highly sensitive and carry the
  permissions the user approved.
- Provider authorization endpoints, scopes, gateway protocols and
  account-sharing terms change independently of this service.

See [accounts and pools](../architecture/accounts-and-pools.md) and the
[gateway](../architecture/gateway.md) for the mechanisms.
