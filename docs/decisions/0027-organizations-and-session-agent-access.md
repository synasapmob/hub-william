# ADR-0027: Organizations and session agent access

- Status: Accepted for organization pages and browser sessions; gateway-key scope remains open
- Date: 2026-09-23
- Partially supersedes: ADR-0024's four-page app list and ADR-0025's personal-only Playground account choices

## Context

The operator requested a separate Organization area for multiple teams. Its
Overview shows the selected team's Agents, Members, Requests, Tokens and daily
usage; Agents, Members and Usage have their own routes. A member should be able
to use an agent available to the organization.

## Decision

- A user may own or join multiple organizations. The Organization routes are
  `/organization`, `/organization/agents`, `/organization/members` and
  `/organization/usage`. The first available organization is selected by
  default; a user's later choice is remembered in their browser. Without an
  accepted organization, Overview presents creation and pending invitations;
  Agents, Members and Usage are disabled, and direct visits return to Overview.
  Creation accepts a name and an optional description of up to 350 characters;
  the same form appears on the empty Overview and in the New organization dialog.
- An owner invites an existing Hub username. Pending invitations grant no
  organization access. The invited user accepts or declines from Organization;
  the owner can cancel a pending invitation or remove an accepted member.
- Agents are existing connected accounts shared by their connection owner into
  an organization. Any accepted member or owner may share their own connected
  account through Connect Agent, including an account already connected in
  Workspace. All accepted members may use it. The sharer or organization owner
  may remove the share. A removed member, deleted connection or transferred
  connection loses its share. Provider credentials stay on the API.
- Organization Agents uses the Workspace provider/account explorer layout.
  With no agents shared yet, the explorer stays visible with zero provider
  counts rather than switching to a separate empty-state card.
  Provider quota metrics appear only for providers supported by the Workspace
  account-usage capability; AGY and DeepSeek do not show a quota section.
  Organization requests and reported tokens are a separate ledger and appear
  in an account detail only after that account has requests in the selected
  30-day period. The detail does not show pool members, join requests or a
  Playground shortcut. Members may connect an account directly from this page;
  a completed connection is then shared with the selected organization.
- Playground offers Personal and accepted organizations. Organization mode lists
  only that organization's shared agents and pins model and generation requests
  to the chosen connection. It uses the existing browser session and never
  silently falls back to a personal or unrelated organization agent.
- Overview and Usage read organization-scoped generation events. Requests count
  successful provider generation responses. Model discovery, failed provider
  responses and earlier personal requests are excluded. Provider-reported input
  and output tokens are summed when known; cached input is a subset of input,
  not an extra amount. Unknown token counts stay unknown and the UI shows the
  number of requests with reported token counts. Daily periods use UTC dates.
  Subscription usage is not a monetary cost, so Organization does not show a
  fabricated spend figure.
- Existing personal gateway keys keep their existing pool reach. How a user
  should create and select an organization-scoped gateway key remains an open
  operator decision. This record does not grant organization access to a
  personal key.

## Consequences

Organization views and Playground require authenticated membership checks on
every request. Removing a membership or connection immediately removes future
access; recorded usage stays attributed to the organization and member. Live
token totals depend on what the upstream provider reports. A real provider
credential is required to verify a live model conversation end to end.
