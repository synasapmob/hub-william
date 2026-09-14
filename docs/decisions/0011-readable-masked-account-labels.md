# ADR-0011: Readable masked account labels

- Status: Accepted
- Date: 2026-09-14
- Supersedes: ADR-0007 account-label masking only

## Context

The short public label from ADR-0007 hides the complete domain stem and most of
the local part. Owners with several accounts from the same managed tenant
cannot reliably tell those pools apart. Provider credentials already contain
the source email address, while the browser and database must continue to
receive only a masked label.

## Decision

- Remove a local-part `+alias` before producing the public account label.
- Show at most the first two and last three non-overlapping characters of the
  base local part, separated by `**`.
- Show at most the first three characters of the first domain label and the
  final domain suffix, separated by `**`.
- For example,
  `10279579+maplenorth@utc2eduvn.onmicrosoft.com` becomes
  `10**579@utc**.com`.
- Recompute stored labels from encrypted provider credentials when the API
  starts, so existing pools adopt the same format without exposing raw account
  identifiers to the browser or database.
- A credential that cannot be decrypted or does not contain an email keeps its
  existing public fallback instead of blocking API startup.

## Consequences

- Pool owners can distinguish accounts while the complete local part, alias,
  tenant name, and intermediate domain labels remain hidden.
- New authorizations, token refreshes, connection lists, pool cards, and pool
  availability all consume the same backend-owned masked value.
- Startup performs one bounded pass over connected credentials and writes only
  labels whose value changed.
