# Architecture decisions

These records govern the whole repository. Frontend-only implementation and
convention documents live in `apps/frontend/docs/`; decisions here define boundaries
between applications and infrastructure.

Records are append-only in status: replace an accepted decision with a newer
record and mark the old one superseded rather than rewriting its history.

- [ADR-0001: Monorepo application boundaries](0001-monorepo-application-boundaries.md)
- [ADR-0002: Public browsing and session-gated pool requests](0002-public-browsing-and-session-auth.md)
- [ADR-0003: Provider OAuth and a user-scoped agent gateway](0003-provider-oauth-and-user-scoped-gateway.md)
- [ADR-0004: Railway private backend behind the frontend origin](0004-railway-private-backend.md)
- [ADR-0005: Accepted pool membership grants gateway access](0005-accepted-pool-gateway-access.md)
- [ADR-0006: Provider-scoped multi-pool gateway failover](0006-provider-scoped-multi-pool-failover.md)
- [ADR-0007: Pool cooldown and owner membership controls](0007-pool-cooldown-and-owner-membership-controls.md)
- [ADR-0008: Application layout and staged gateway extraction](0008-application-layout-and-staged-gateway-extraction.md)
- [ADR-0009: Telegram webhook adapter boundary](0009-telegram-webhook-adapter-boundary.md)
- [ADR-0010: Credential-aware pool recovery](0010-credential-aware-pool-recovery.md)
- [ADR-0011: Readable masked account labels](0011-readable-masked-account-labels.md)
- [ADR-0012: Current Grok device authorization](0012-current-grok-device-authorization.md)
- [ADR-0013: Periodic provider credential refresh](0013-periodic-provider-credential-refresh.md)
- [ADR-0014: Google OAuth Gemini subscription gateway](0014-google-oauth-gemini-subscription-gateway.md)
