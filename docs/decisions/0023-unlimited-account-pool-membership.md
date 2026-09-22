# ADR-0023: Unlimited account pool membership

- Status: Accepted
- Date: 2026-09-22
- Supersedes: ADR-0006 per-pool member capacity only

## Context

The operator clarified that account sharing has no member-count limit. The
legacy capacity of six still blocked join requests, owner invitations and
request acceptance, while the UI displayed a misleading `Members · 1/6`.

## Decision

- Account pools allow any number of members. Join requests, invitations and
  request acceptance do not compare the member count against a capacity.
- Display the current total as `Members · N`, including the owner and accepted
  members, without a denominator or a full-pool state.
- Invitations and request decisions remain owner-only. Existing duplicate
  membership protection, request validation and member removal remain in force.
- Retain the legacy `capacity` database column and response field for API
  compatibility; neither controls sharing or the current UI.

## Consequences

Existing memberships need no migration. Provider quotas, per-member usage
accounting and gateway authorization remain independent of member-count limits.
