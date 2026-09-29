# ADR-0046: My organizations dialog and organization removal

- Status: Accepted; the browser-remembered default, the per-organization Overview and Members requests behind the table, and the first remaining organization becoming the default after a removal are superseded by [ADR-0047](0047-server-side-default-organization-and-summaries.md)
- Date: 2026-09-29
- Authority: operator request of 2026-09-29. The Organization header gets a
  "My organizations" button beside "New organization". Its dialog lists the
  organizations the user has joined with their agents, members, tokens, owner
  and creation date, and a Remove button that asks an owner whether to delete
  the organization for everyone and a member whether to leave it. Invitations
  move into the same dialog. The switcher beside the "Organization" label goes
  away; choosing an organization in the dialog makes it the default. Later the
  same day: the header shows the default organization as a larger Badge with
  36px buttons, every Organization page loads through skeletons shaped like its
  elements, and an invitation bell beside Log out in the sidebar opens the
  dialog through `?tab=my-organization`.
- Partially supersedes: [ADR-0027](0027-organizations-and-session-agent-access.md)
  (where an invited user accepts or declines, and how the selected organization
  is chosen). Everything else in ADR-0027 stands.

## Context

The Organization page switched teams with a select in its header and showed
pending invitations as a card above the page content. The API had no way to
delete an organization or to leave one: an owner could only remove other
members, and a member had no removal route at all.

## Decision

**My organizations.** A signed-in user always sees "My organizations" in the
Organization header, including a user with no organization, so pending
invitations stay reachable. The button carries the pending-invitation count.
The header switcher is removed; the header shows the default organization's
name as plain text.

The dialog has two sections:

- **Joined organizations**, a table of name, owner, agents, members, reported
  tokens for the last 30 days, creation date and Remove. The default
  organization is marked. Choosing a row makes it the default and closes the
  dialog. The choice is remembered per user in the browser, as before, and
  clears a stale `?member=` filter. The values come from the existing Overview
  and Members endpoints, so there is no new list contract; the owner is the
  member whose role is `owner`. Queries run only while the dialog is open and
  share their cache with the Overview and Members pages.
- **Invitations**, with Accept and Decline. Accepting still makes the joined
  organization the default. A load failure offers Retry inside the dialog. The
  card above the page content is removed.

**Header.** The default organization's name is a Badge after the "Organization"
label and a thin divider, sized to the 36px buttons beside it. "My organizations"
and "New organization" are 36px high with wider horizontal padding.

**Dialog in the URL.** The dialog is open while the search parameter
`tab=my-organization` is present (`?tab=my-organization` on any Organization
page). Opening and closing it replace that parameter instead of adding history
entries, and choosing an organization removes it together with a stale
`?member=` filter in one update. Someone signed out never sees the dialog, so
signing in with the parameter present opens it. Because a link can open the
dialog before its data has arrived, the dialog shows its own skeleton rows.

**Invitation notifications.** A bell beside Log out in the sidebar counts the
pending invitations. Its popover lists each one, and choosing one goes to
`/organization?tab=my-organization` so the user accepts or declines there.
The bell shares the Organization page's invitations query, refetches on focus
and reconnect like any other query and does not poll. It skips those refetches
while Playground is open, as the organization navigation already does.

**Loading states.** Every Organization page renders its skeleton from the first
paint. The session check, the organization list and each page's own queries lead
to one continuous skeleton instead of "Loading…" text, then a bare header, then
placeholders that claim an empty state. Titles and labels stay real text; only
values, lists and charts become placeholders, at the heights they will have. The
organization is `null` in the outlet context while the session or the list is
loading, so each page renders itself without data. When loading finishes the
page shows the organization, or the create form for someone who has joined
none. A header skeleton stands in for the name and buttons until then, and
"—", zero counts and "No … yet" messages appear only for data that has loaded.

**Remove.** Remove is one button with two meanings, chosen by the user's role,
and always behind a confirmation:

- An **owner** deletes the organization. The confirmation says everyone in it
  will leave and that its members, shared agents and usage history are removed.
  `DELETE /organizations/{id}` is owner-only (`403` for anyone else). It
  deletes the organization, every membership including pending invitations,
  the agent links and the organization's recorded usage, all by existing
  cascades. The Workspace connections behind shared agents are not touched.
- A **member** leaves the organization. The confirmation says they can no
  longer use anything related to it. `DELETE /organizations/{id}/membership`
  removes only the caller's accepted membership. The agents they shared are
  unlinked from the organization; their Workspace connections stay connected
  and recorded usage stays attributed to the organization. An owner cannot
  leave (`422`; they delete instead), and someone with only a pending
  invitation gets `403` and declines it instead. A member who left can be
  invited again.

After a removal the organization list refreshes. If the removed organization
was the default, the first remaining organization becomes the default; with
none left the page shows its create form. Nothing is refetched for the removed
organization.

## Consequences

- Deleting an organization cannot be undone and takes its usage history with
  it. Ownership transfer is not offered, so an owner who wants out must delete.
- An API deployment without the two endpoints answers `404`, and the
  confirmation shows that error rather than pretending to succeed. The API must
  be deployed before the frontend's Remove works.
- The dialog reads Overview and Members once per organization. That is fine for
  a handful of teams; a summary endpoint is the follow-up if users join many.
- Token totals in the table are the 30-day reported figure the Overview page
  defaults to, and stay unknown (an em dash) when the provider reported none.
- The invitation bell updates on the next fetch, not the moment an invitation is
  sent, because nothing polls or pushes. Focusing the tab is enough.
- A skeleton cannot know which page it will become. While the role is unknown,
  Members reserves the invite column, so a member's list widens once loaded.
