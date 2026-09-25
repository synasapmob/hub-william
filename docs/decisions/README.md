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
- [ADR-0015: DeepSeek API keys and OpenCode gateway installation](0015-deepseek-api-key-and-opencode-gateway.md)
- [ADR-0016: OpenCode subscription protocol compatibility](0016-opencode-subscription-protocol-compatibility.md)
- [ADR-0017: OMP one-command provider installation](0017-omp-one-command-provider-installation.md)
- [ADR-0018: Provider-backed AGY model discovery](0018-provider-backed-agy-model-discovery.md)
- [ADR-0019: Current Antigravity model and generation contract](0019-current-antigravity-model-contract.md)
- [ADR-0020: DeepSeek Responses for coding-agent clients](0020-deepseek-responses-for-coding-agent-clients.md)
- [ADR-0021: Transparent request sizing for agent gateway routes](0021-transparent-request-sizing-agent-gateway.md)
- [ADR-0022: Bounded transient gateway retries](0022-bounded-transient-gateway-retries.md)
- [ADR-0023: Unlimited account pool membership](0023-unlimited-account-pool-membership.md)
- [ADR-0024: Tools, Agents and demo Playground](0024-tools-agents-playground.md)
- [ADR-0025: Session-backed model Playground](0025-session-backed-playground.md)
- [ADR-0026: Railway-only deployment](0026-railway-only-deployment.md)
- [ADR-0027: Organizations and session agent access](0027-organizations-and-session-agent-access.md)
- [ADR-0028: Gemini forbidden pool failover](0028-gemini-forbidden-pool-failover.md)
- [ADR-0029: Current provider model catalogue convention](0029-current-provider-model-catalogues.md)
- [ADR-0030: Nightly connected-account credential check](0030-nightly-connected-account-credential-check.md)
- [ADR-0031: Explicit AGY account verification challenge](0031-explicit-agy-account-verification.md)
