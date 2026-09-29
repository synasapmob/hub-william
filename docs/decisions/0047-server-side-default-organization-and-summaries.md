# ADR-0047: Server-side default organization and organization summaries

- Status: Accepted
- Date: 2026-09-30
- Authority: operator request of 2026-09-30 to give the features ADR-0046 added
  in the frontend a real backend instead of leaving them to the browser and to
  endpoints built for other pages, and to ship the result to `dev` and `main`.
- Partially supersedes: [ADR-0046](0046-my-organizations-dialog-and-organization-removal.md)
  (where the default organization is remembered, how the My organizations table
  gets its values, and which organization becomes the default after a removal).
  Everything else in ADR-0046 stands.

## Context

ADR-0046 shipped the My organizations dialog with two frontend stand-ins. The
default organization lived in the browser's `localStorage`, so it was lost on
another device or after clearing site data. The table built each row from the
Overview and Members endpoints, two requests per organization on every open.
Both are behaviors the API should own.

## Decision

**The default organization is stored on the server.** It is the organization a
member's Organization pages open with, kept on the membership row
(`organization_memberships.is_default`). A check constraint allows it only on an
accepted membership and a partial unique index allows one per user. Leaving an
organization, being removed from it, and its deletion delete the membership, so
they clear the default with no cleanup code.

- `PUT /organizations/{id}/default` makes an organization the caller's default
  and clears the previous one. It answers `204`, repeating it changes nothing,
  and it answers `403` for anyone who is not an accepted member, including
  someone with only a pending invitation.
- `Organization` gains `is_default`. The plain list, create, accept and the
  organization inside Overview all carry it, for the caller.
- **Creating an organization and accepting an invitation make it the default**
  in the same transaction. The frontend already switched to the new
  organization, and doing it on the server means no second request that could
  fail after the first succeeded.
- Every change of a user's default takes one per-user advisory lock
  (`pg_advisory_xact_lock` on `organization-default:<user id>`) before it
  touches a row, including the ones that add the membership. Two requests from
  one user queue instead of tripping the unique index, and different users never
  wait on each other.
- A user has **no default until they create, join or choose one**, and nothing
  replaces it silently when it goes away. The frontend shows the oldest
  organization meanwhile, and the dialog marks the organization the pages are
  showing. Choosing that one saves it. This replaces ADR-0046's "the first
  remaining organization becomes the default".
- The frontend no longer reads or writes `hub-william:organization:<user id>` in
  `localStorage`. Existing keys are ignored and left where they are, and the
  browser-remembered choice is not migrated. Choosing a row writes the new
  default into the cached organization lists, so nothing is refetched, and
  choosing the organization that is already the server's default sends nothing.
  A choice that fails keeps the dialog open with the error and leaves the pages
  as they were.

**One request feeds the table.** `GET /organization-summaries?days=` returns
each organization the caller has joined, oldest first, with its owner's
username, agent count, member count and recorded usage over the last `days` UTC
days (default 30, 1 through 365, validated like Overview). The counts and sums
follow the Overview rules: only connected accounts still owned by an accepted
member count as agents, only accepted members count as members, and a request
that reported no tokens counts as a request but not as token-known. A test
compares every field with the organization's own Overview for both roles and
several periods, so a row cannot drift from its page.

The summaries are a separate endpoint on purpose. The plain
`GET /organizations` is fetched by the sidebar and Playground on every page and
only needs names, and the usage sums scan the events in the window, which grows
with use. The dialog asks for summaries only while it is open, with `days=30`
for its "Tokens 30d" column, and shows its own skeleton rows, an error with
Retry, or the empty message.

**CORS allows `PUT`.** `PUT /organizations/{id}/default` is the first browser
call with that method, and the CORS layer allowed only `GET`, `POST` and
`DELETE`, so a browser refused the call before it reached the handler while
every API test still passed. The layer now allows `PUT`, and a test sends a
preflight for every method the OpenAPI document declares.

## Consequences

- The migration `20260930000022_add_default_organization.sql` adds a column, a
  check and a unique index. Nobody has a default until they create, join or
  choose one, so existing users see their oldest organization first.
- The API must be deployed before the frontend. Against an API without
  `/organization-summaries` the dialog shows the error and Retry while the
  plain list keeps the pages working, and choosing a default fails with its
  error in the dialog.
- Summaries are computed on every open. The `(org_id, created_at)` index bounds
  each organization's scan to the window; caching them is the follow-up if a
  team's usage grows large.
- The default is read only by the Organization pages. Playground and the
  gateway do not use it.
- Ownership transfer is still not offered, so an owner who wants out deletes
  the organization.
