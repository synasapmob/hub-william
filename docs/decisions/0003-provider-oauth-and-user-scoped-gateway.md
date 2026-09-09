# ADR-0003: Provider OAuth and a user-scoped agent gateway

- Status: Accepted; gateway-account selection superseded by ADR-0005
- Date: 2026-09-10
- Supersedes: ADR-0002

## Context

Hub William remains publicly browsable while pool membership actions require a
Hub identity. A signed-in user also needs to connect their own ChatGPT, Claude,
or Grok account from the web and point supported local agents at one gateway.
The provider password must stay on the provider's official page. Device and
authorization-code grants contain bearer credentials that must not reach the
browser after exchange.

The installer asks for one Hub key after the user chooses any combination of
Codex, Claude Code, and Grok. That means the Hub key identifies a user, not one
provider connection; the requested gateway path selects the matching connected
provider account.

## Decision

- Catalogue and pool browsing remains public. Login, registration, join
  requests, provider connections, and gateway-key management are authenticated.
- Hub browser authentication uses a five-hour access cookie plus a rotating
  seven-day refresh cookie. Each successful refresh invalidates both old hashes,
  issues both new cookies, and starts a new seven-day refresh window.
- Connect Agent asks the backend to begin the provider's device or PKCE flow,
  then opens only the provider-returned official HTTPS URL in a new browser
  window. Claude's manual callback value returns to the backend for exchange.
- Authorization state and provider token payloads are encrypted with AES-256-GCM
  before PostgreSQL storage. Provider access expiry follows `expires_in`.
  Refresh responses replace a refresh token when one is returned and otherwise
  preserve the existing one; the app does not invent a provider refresh expiry.
- Gateway keys are random, user-scoped bearer secrets returned once. PostgreSQL
  stores only SHA-256 hashes and the final four display characters. Keys can be
  listed and revoked.
- Gateway routes select the connected provider account for the key's user,
  refresh near-expiry provider credentials under a database lock, and stream
  the upstream response. A key cannot route to a provider the user has not
  connected.
- The Python installer preserves unrelated local configuration, creates a
  one-time backup, writes atomically with owner-only permissions, and stores the
  Hub key in the selected agents' configuration because those clients need it
  for unattended requests.
- Pool discovery and request UI remains separate from checkout, QR, payment,
  and Telegram commerce.

## Consequences

- Production must provide HTTPS, a strong credential-encryption key, exact CORS
  origin, secure cookies, and secret rotation/revocation procedures.
- A compromised Hub database does not expose gateway-key plaintext, but a
  compromised application host with the encryption key can decrypt provider
  credentials. A compromised user machine can read its locally installed Hub
  key.
- Provider authorization endpoints, scopes, upstream gateway protocols, and
  account-sharing terms can change independently. Failures must remain explicit;
  the service must never replace them with mock success.
- Provider passwords stay outside Hub William, but connected bearer and refresh
  tokens are highly sensitive and grant the permissions approved by the user.
