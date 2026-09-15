# ADR-0012: Current Grok device authorization

- Status: Accepted; OAuth scope list superseded by ADR-0016
- Date: 2026-09-15
- Supersedes: ADR-0003 Grok authorization transport only

## Context

Grok Build moved OAuth authentication from a legacy account-host endpoint to
the OIDC issuer at `auth.x.ai`. The legacy device URL now returns an HTML 403
response, which the API correctly refuses to treat as credentials but surfaces
to users as an unexpected authorization response.

The current official Grok Build client uses the RFC 8628 device endpoint,
identifies its public OAuth client and client surface explicitly, and opens the
provider-returned verification URL on `accounts.x.ai`.

## Decision

- Start Grok device authorization at the configured issuer's
  `/oauth2/device/code` endpoint with the public client ID and the scopes
  `openid profile email offline_access api:access` as form data.
- Send the current Grok Build client version and `grok-build` surface on device,
  polling, and refresh requests. Keep the public client ID and version
  overridable through environment configuration so a provider rollout does not
  require a source patch.
- Poll and refresh through the issuer's `/oauth2/token` endpoint using the same
  client identity.
- Accept the official split origin: OAuth requests go to `auth.x.ai`, while the
  user-facing device verification URL is restricted to HTTPS on
  `accounts.x.ai`. Non-production issuer overrides continue to require a
  same-origin verification URL.
- Log only HTTP status and content type when a successful authorization response
  cannot be parsed. Never log device codes, user codes, tokens, or response
  bodies.

## Consequences

- Grok connections use the current official device authorization contract
  instead of parsing an HTML denial from the retired route.
- Existing credentials continue through the shared refresh/reconnect lifecycle;
  rejected legacy refresh tokens trigger same-pool reauthorization.
- Future client identity changes can be rolled out with
  `GROK_AUTH_CLIENT_ID` and `GROK_CLIENT_VERSION` without exposing either value
  to the browser.
