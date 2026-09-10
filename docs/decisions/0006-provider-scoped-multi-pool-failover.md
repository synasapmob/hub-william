# ADR-0006: Provider-scoped multi-pool gateway failover

- Status: Accepted
- Date: 2026-09-10
- Supersedes: ADR-0005 gateway-account selection only

## Context

A Hub user may connect more than one account for the same provider and may be
accepted into any number of distinct account pools. One user-scoped gateway key
must keep working across all of those accounts without binding the installed
agent to one pool.

The requested gateway route already identifies the provider: Claude traffic,
for example, must never fall back to a ChatGPT or Grok pool. A connected account
may also be temporarily unusable or return an upstream rate limit while another
authorized account for that provider remains available.

ChatGPT's current signed token metadata places `chatgpt_plan_type` inside the
`https://api.openai.com/auth` claim object. The earlier flat-claim parser did
not recognize that shape and left verified Plus and K12 connections without a
display plan.

## Decision

- A Hub user may create unlimited connection records, including multiple
  connected accounts for the same provider.
- A requester may join unlimited distinct pools. The existing one-request per
  requester and connection rule remains so one pool cannot accumulate duplicate
  requests from the same person; pool capacity remains owner-account specific.
- Every gateway key remains user-scoped. Candidate connections include all
  connected accounts owned by that user and all pools where that user's request
  is accepted, filtered strictly to the provider named by the gateway route.
- Owned connections are tried before accepted memberships. Within each group,
  the most recently updated connection or membership is tried first.
- An unusable stored credential advances to the next same-provider candidate.
  An upstream HTTP `429` advances to the next same-provider candidate when one
  exists. Other upstream responses are returned without cross-provider retry.
- Gateway keys remain hash-only at rest and list only masked metadata. The full
  secret is returned once at creation; creation, listing, and revocation live in
  a dedicated authenticated browser dialog.
- Provider plan extraction supports the verified nested ChatGPT claim and
  normalizes the known `plus`, `k12`, and `max` labels for display.

## Consequences

- One installed key can serve Codex, Claude Code, and Grok while each route uses
  only pools for its own provider.
- A rate-limited candidate can add one failed upstream attempt before the same
  request succeeds through the next pool. No cooldown is persisted until a
  provider-neutral reset contract is verified.
- Revoking a membership or disconnecting an account removes it from the
  candidate set immediately without rotating the user's gateway keys.
