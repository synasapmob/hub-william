# Organizations

An organization is a team that shares provider accounts ("agents") and reads their combined usage. The API in `apps/api/src/api/organizations/` owns the data and every permission check; the pages under `apps/frontend/src/routes/_app.organization*` render it. An organization agent is a link to a connection that its sharer owns, not a copy, so it inherits that connection's credentials and lifecycle (see [Accounts and pools](./accounts-and-pools.md)). Organization requests reach providers through Playground ([Playground](./playground.md)) and the [Gateway](./gateway.md).

## Data model

Defined in `apps/api/migrations/20260923000019_create_organizations.sql`, `..._add_organization_description.sql` and `..._add_default_organization.sql`.

| Table                       | Key columns and constraints                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `organizations`             | `name` VARCHAR(80), not blank; `description` VARCHAR(350), nullable                                                                                                                                                                                                |
| `organization_memberships`  | One row per (`org_id`, `user_id`). `role` is `owner` or `member`; `status` is `pending` or `accepted`. An owner is always accepted. `joined_at` is set exactly when accepted. `is_default` is allowed only when accepted. `invited_by_user_id` is set when invited |
| `organization_agents`       | PK (`org_id`, `connection_id`); `owner_user_id` is the sharer. A composite foreign key to the sharer's membership cascades, and the foreign key to `agent_connections` cascades                                                                                    |
| `organization_usage_events` | One row per recorded request: `user_id`, `connection_id` (SET NULL when the connection is deleted), `provider`, `model`, nullable `input_tokens`, `output_tokens`, `cached_tokens`, `created_at`                                                                   |

Indexes enforce the invariants:

- **One owner per organization:** a unique partial index on `org_id` where `role = 'owner'`. Ownership cannot be transferred.
- **One default per user:** a unique partial index on `user_id` where `is_default`.
- **Transfer trigger:** `agent_connection_owner_transfer_removes_organization_shares` deletes an agent's organization links when its connection changes owner, so a former owner cannot grant access for the new one.

Deleting an organization cascades to its memberships, agent links and usage events. Deleting a user cascades to their memberships and usage events. Deleting a connection deletes its links and keeps its usage events with `connection_id` set to NULL.

## Permissions

All routes need a session (401 without one) and are in `apps/api/src/api/organizations/routes.rs`. Errors map to 403 (`forbidden`), 404 (`not_found`) and 422 (`validation_error`).

- **Viewing** an organization's overview, agents, members or usage needs an accepted membership. A pending invitee has no access and gets 403.
- **Owner only:** invite a member, remove a member or cancel an invitation, delete the organization.
- **Any accepted member:** share their own connected account, leave (members only), read everything.
- **Unshare:** the account's owner or the organization owner.
- **Write budget.** Every write (all `POST`, `PUT` and `DELETE` routes below) spends from one shared bucket of 10 per minute per user (`Limit::OrganizationWrite`). Reads are not limited.

## Endpoints

| Method and path                                     | Caller                              | Behaviour                                                                                                                                                                                                                        |
| --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /organizations`                                | Signed in                           | Accepted memberships, oldest organization first, each with the viewer's `role` and `is_default`                                                                                                                                  |
| `POST /organizations`                               | Signed in                           | 201. `name` 1 to 80 characters after trimming; optional `description` of at most 350 characters (counted in characters, blank stored as NULL). The creator becomes owner, accepted and default                                   |
| `GET /organization-summaries?days=`                 | Signed in                           | The My organizations table: for each organization the owner, agent count, member count and usage over `days` (default 30)                                                                                                        |
| `GET /organization-invitations`                     | Signed in                           | The viewer's pending memberships                                                                                                                                                                                                 |
| `POST /organization-invitations/{id}/accept`        | Invitee                             | 200 with the organization. Sets the membership accepted and makes it the viewer's default. 404 unless the row is theirs and pending                                                                                              |
| `DELETE /organization-invitations/{id}`             | Invitee                             | 204. Deletes the pending row; 404 otherwise                                                                                                                                                                                      |
| `DELETE /organizations/{id}`                        | Owner                               | 204. Deletes the organization and everything under it. The connections behind shared agents are untouched                                                                                                                        |
| `PUT /organizations/{id}/default`                   | Accepted member                     | 204, idempotent. 403 if not an accepted member                                                                                                                                                                                   |
| `DELETE /organizations/{id}/membership`             | Accepted member                     | 204. Leaves the organization and unlinks the agents the member shared. An owner gets 422 and must delete instead                                                                                                                 |
| `GET /organizations/{id}/overview?days=`            | Accepted member                     | Member count, agent count, request and token totals, zero-filled daily usage and the shared agent list                                                                                                                           |
| `GET /organizations/{id}/agents?include_usage=`     | Accepted member                     | Shared agents with plan, availability and `validation_url`. With `include_usage=true`, live provider quota is added for providers whose catalogue flag `usage_metrics` is set                                                    |
| `POST /organizations/{id}/agents`                   | Accepted member                     | Body `connection_id`. The connection must be `connected` and owned by the caller (404 if not found or not connected, 403 if owned by someone else). 201 on a new link, 200 with the link that already exists when already shared |
| `DELETE /organizations/{id}/agents/{connection_id}` | Account owner or organization owner | 204; 404 if there is no link                                                                                                                                                                                                     |
| `GET /organizations/{id}/members`                   | Accepted member                     | Owner first, then accepted, then pending, each with `role`, `status`, `joined_at`, `invited_at` and inviter                                                                                                                      |
| `POST /organizations/{id}/members`                  | Owner                               | 201. Body `username`, normalized to lowercase `[a-z0-9_-]{3,32}`. Creates a pending member. 404 for an unknown user; 422 for the owner themselves or for someone already invited or a member                                     |
| `DELETE /organizations/{id}/members/{username}`     | Owner                               | 204. Deletes the matching `member` row, accepted or pending, so it removes a member and cancels an invitation. 404 if none matches; the owner row is never matched                                                               |
| `GET /organizations/{id}/usage`                     | Accepted member                     | Totals, daily usage and a breakdown by member, connection, provider and model. Filters: `days`, `member_id`, `connection_id`, `model`                                                                                            |

## Default organization

The default is the organization the Organization pages open with. It lives on the membership row (`is_default`), so it follows the user to every browser and clears itself when the user leaves, the owner deletes their membership or the organization is deleted.

- **Setting it.** Creating an organization, accepting an invitation and `PUT /organizations/{id}/default` all call `make_default_organization`. It takes a per-user advisory lock, checks the viewer is an accepted member, clears the previous default and sets the new one. The lock makes concurrent requests from one user queue instead of tripping the one-default index.
- **Fallback.** Until a default exists, the frontend shows the first organization returned by `GET /organizations`, which is the oldest by creation date.
- **Scope.** Only the Organization pages read `is_default`. The default is not shared with other users.

## Invitations and members

- An owner invites by Hub username. The invitee sees the invitation in the sidebar bell and in the My organizations dialog (below) and accepts or declines it.
- Accepting makes the organization the invitee's default.
- `GET /organizations/{id}/members` is visible to every accepted member. The Members page shows each member's request count for the last 30 days with a View usage link, every member sees the pending invitations, and the owner additionally gets an invite form, Remove on accepted members and Cancel on pending invitations.
- The owner's membership cannot be deleted, cannot be left and cannot be reassigned. Owners delete the organization.

## Linked agents

An organization agent is `organization_agents (org_id, connection_id, owner_user_id)`. It points at the sharer's Workspace connection.

- **Refresh and reconnect update everywhere.** The link has no credential of its own. When the owner refreshes, reconnects or the credential rotates, every organization and Playground reads the new state on its next fetch; nothing is pushed to other browsers. The exception is a different Hub user connecting the same provider account: ownership of the connection moves to that user, and a database trigger deletes the connection's organization links.
- **Deleting the connection** in Workspace deletes every link to it. **Unsharing** deletes only the link; the account stays connected and keeps serving its pools.
- **Sharing is idempotent.** Sharing an already shared account returns 200 with the link that already exists and creates no duplicate, including under concurrent requests (`ON CONFLICT DO NOTHING`).
- **Which links count.** An agent is listed and usable only while its connection is `connected`, still belongs to the sharer, and the sharer is still an accepted member. The same rule drives the Overview agent count, the My organizations agent count and the agent list.
- **Who serves requests.** In organization scope, only linked agents of accepted members are candidates, and the caller must also be an accepted member. Personal pools are never mixed in. Candidate ordering and failover are in [Gateway](./gateway.md).
- **Refresh, reset credits and Verify with Google** are owner-only actions on the underlying connection. The sharer sees them in the organization agent dialog; other members see a note asking the sharer to reconnect. Hub keys (gateway keys) are personal and are never organization-scoped: `gateway_keys.organization_id` exists but key creation never sets it.

## Usage

Usage events are written by the gateway (`record_organization_usage` in `apps/api/src/api/gateway/mod.rs`) for requests whose selection carries an organization, which today means Playground requests made in organization mode.

- **When an event is written.** After a 2xx upstream response whose stream is read to its end and carries the provider's completion marker (for Claude only `end_turn`, `stop_sequence` and `refusal` count). Claude and Gemini count-tokens calls and model discovery are never recorded. A Call Live session (`/playground/voice`) records one event when the session is set up, with unknown tokens. Hub keys are personal today, so in practice events come from Playground requests made in organization mode.
- **Unknown versus zero.** Token columns are nullable. A provider that does not report a count stores NULL. Sums skip NULL (`known_input_tokens`, `known_output_tokens`, `known_cached_tokens`). `token_known_requests` counts events that reported both input and output tokens. The UI shows "—" when it is 0. The Overview prints "Reported by N of M requests" next to token totals, and the Usage page prints "Token counts were reported for N of M requests. Requests without provider usage remain in the request count."
- **Claude token accounting.** The input total is `input_tokens` plus cache-read and cache-creation tokens; `cached_tokens` holds the cache-read part.
- **Periods.** `days` is 1 to 365 (default 30, otherwise 422), counted in UTC calendar days including today. The window starts at 00:00 UTC of the first day and ends at the next midnight. `daily_usage` has exactly one row per day, zero-filled. The UI offers 7, 30 and 90.

## Frontend

The routes live in `apps/frontend/src/routes/_app.organization*`; the service is `src/services/organizations/organizations-service.ts`, which repeats a call once after a 401 and a successful session refresh.

### Layout contract

`_app.organization/route.tsx` is the layout for all four pages.

- It loads `GET /organizations` and `GET /organization-invitations` for a signed-in user. The displayed organization is the one with `isDefault`, else the first in the list.
- `loading` is true while the session check or the first organization list is pending. In that state it renders a header skeleton and an `<Outlet>` with `organization = null`; each page renders its own skeleton.
- The `<Outlet>` is keyed by organization id (`"loading"` while unknown), so choosing another organization remounts the page and drops its local filters.
- Sub-pages redirect to `/organization` when the session has loaded and the viewer is signed out, or the list loaded without error and is empty.
- A signed-out viewer sees a sign-in call to action; a signed-in viewer with no organization sees an inline create form. The New organization button appears only once the viewer belongs to one.
- `useOrganizationContext()` gives pages `{ organization }`; `requireOrganization()` throws if a mutation runs before it is known.

### Pages

| Route                   | Content                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/organization`         | Overview: agents, members, requests and tokens for a 7, 30 (default) or 90 day range, daily usage chart, shared agents                                                               |
| `/organization/agents`  | Provider and account explorer of shared agents, fetched with `include_usage=true`. All / Mine filter and search over label, owner and plan. Opening an agent shows its detail dialog |
| `/organization/members` | Members, pending invitations and, for the owner, the invite form                                                                                                                     |
| `/organization/usage`   | Requests and tokens with member, agent and model filters (`?member=` in the URL), a per-member, agent and model breakdown, and a 7, 30 or 90 day range                               |

- **Agent detail dialog.** Usage metrics show for providers with `usage_metrics`. A 30-day organization usage section appears when the agent has requests. The sharer sees credential refresh, Reset credits and, for a `reauth_required` account with a `validationUrl`, Verify with Google. The sharer and the organization owner see Remove from organization, which only unlinks.
- **Connect Agent** offers "share a connected agent" for the viewer's unshared, connected accounts, or connects a new account and shares it automatically.
- **Usage filters** validate themselves: a `member` that is not an accepted member is dropped from the URL once the members list loads; an agent or model that is not in the data is ignored.

### My organizations dialog

The dialog is open while `?tab=my-organization` is in the URL (constants in `src/utils/utils.organization-tabs.ts`). The sidebar bell links to it, and closing it deletes the parameter.

- The table comes from one `GET /organization-summaries` request, enabled only while the dialog is open. It lists every joined organization with its owner, agents, members, 30-day tokens and creation date.
- Selecting a row calls `PUT /organizations/{id}/default` (skipped when the row is already the default), then updates the cached lists and drops the `member` filter.
- Remove is Delete for an owner (`DELETE /organizations/{id}`) and Leave for a member (`DELETE /organizations/{id}/membership`). Afterwards cached queries for that organization are not refetched, because they would only return 403.
- The Invitations section accepts (`POST .../accept`) or declines (`DELETE`) each pending invitation and shows their count on the My organizations button.
