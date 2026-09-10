# ADR-0002: Public browsing and session-gated pool requests

- Status: Superseded by ADR-0003
- Date: 2026-09-09

## Context

Hub William lists shared agent account pools publicly. Readers should be able to
inspect compatible agents, plans, available seats, members, and usage without
creating an account. Sending or managing a join request is account-bound and
needs an authenticated identity. Browser checkout and QR payment would mix pool
discovery with a transaction the owner and applicant already coordinate on
Telegram.

## Decision

- Every catalogue and pool route remains public.
- Login and registration use username and password in a shared popup instead of
  dedicated routes. Registration also captures a recovery email, while the
  recovery workflow remains deferred.
- The backend hashes passwords with Argon2 and stores opaque session hashes in
  PostgreSQL. The browser receives only an `HttpOnly` session cookie.
- Request Join opens authentication for a guest. Pool owners review requests by
  Hub William username or Telegram username and accept or reject them.
- The browser contains no checkout, QR, or payment flow. Bill-splitting
  coordination happens directly between users on Telegram.
- Pool cards consume public, already-masked account labels and agent-specific
  usage fields. The underlying provider login never enters a browser response.

## Consequences

- Authentication is a capability gate rather than a wall around public content.
- Production needs an exact frontend CORS origin and secure cross-site cookies.
- Recovery email is stored before any recovery endpoint or email integration is
  introduced.
- Pool, request, membership, and usage fixtures can move behind backend APIs
  without changing the card contract.
- Payments and Telegram automation require separate later decisions and do not
  silently appear in this browser flow.
