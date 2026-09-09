# Architecture decisions

These records govern the whole repository. Frontend-only implementation and
convention documents live in `frontend/docs/`; decisions here define boundaries
between applications and infrastructure.

Records are append-only in status: replace an accepted decision with a newer
record and mark the old one superseded rather than rewriting its history.

- [ADR-0001: Monorepo application boundaries](0001-monorepo-application-boundaries.md)
- [ADR-0002: Public browsing and session-gated pool requests](0002-public-browsing-and-session-auth.md)
- [ADR-0003: Provider OAuth and a user-scoped agent gateway](0003-provider-oauth-and-user-scoped-gateway.md)
- [ADR-0004: Railway private backend behind the frontend origin](0004-railway-private-backend.md)
- [ADR-0005: Accepted pool membership grants gateway access](0005-accepted-pool-gateway-access.md)
