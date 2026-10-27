# Frontend

The frontend is a React Router SPA in `apps/frontend`. It renders the Hub William workspace: Home, Tools, Agents, Playground and the Organization pages. It holds no provider credentials; every account-bound read and write goes through the Rust API in `apps/api`. This document covers the shell, session handling, data fetching, rendering and the Agents page. Other pages have their own documents: [Playground](./playground.md), [Tools](./tools.md) and [Organizations](./organizations.md).

## Route map

Routes are file-based (`flatRoutes()` in `src/routes.ts`). Every page renders inside the `_app` layout.

| Path                                                     | Route module                | Purpose                                                             |
| -------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `/`                                                      | `_app._index`               | Home, a static white paper about sharing tools and agents           |
| `/tools`, `/tools/:contributor`                          | `_app.tools.($contributor)` | Tool catalogue, see [Tools](./tools.md)                             |
| `/agents`                                                | `_app.agents`               | Provider and account explorer, join requests, Hub key dialog        |
| `/playground`                                            | `_app.playground`           | Chat and calls, see [Playground](./playground.md)                   |
| `/organization`                                          | `_app.organization` layout  | Wraps the four pages below, see [Organizations](./organizations.md) |
| `/organization` (index), `/agents`, `/members`, `/usage` | `_app.organization.*`       | Overview, shared agents, members, usage                             |
| any other URL                                            | `$.tsx`                     | `<Navigate replace to="/" />`                                       |

For an unknown URL nginx serves `/__spa-fallback.html`, and the `$.tsx` splat route redirects the client to `/`.

## App shell

`_app/route.tsx` renders `WorkspaceShell` (`src/components/workspace-shell/`), which wraps every page in `WorkspaceShellSession`.

- **Layout.** From the `md` breakpoint up, `WorkspaceShellDesktop` pins a 256px sidebar. Below `md`, `WorkspaceShellMobile` shows a sticky header with a menu button that opens the same sidebar in a `Sheet` drawer. Both consume `workspace-shell-navigation-items.ts`, so every page is reachable on either layout.
- **Contained pages.** `useMatch("/agents")` switches the shell to `h-svh overflow-hidden`. The Agents explorer owns its scroll container, so the page header and mobile header stay visible. Every other page scrolls inside `main`.
- **Navigation groups.** Workspace lists Home, Tools, Agents and Playground. Organization lists Overview, Agents, Members and Usage. Only Overview is a link until the organizations query returns at least one organization; the other three render as disabled buttons.
- **Notifications.** For a signed-in user a bell sits beside Log out in the sidebar and lists pending organization invitations. Each entry links to `/organization?tab=my-organization`, where the user accepts or declines it. Invitations are the only notification type.
- **Account area.** A guest sees a Login button (disabled while the session check runs). A signed-in user sees an avatar, the username, the notification bell and Log out. The avatar is `https://github.com/<username>.png` when the username is a valid GitHub login (`authService.githubAvatarUrl`), otherwise the first three letters of the username. It is display-only and proves nothing about identity.

## Session and auth

`WorkspaceShellSession` owns a `status` of `loading`, `authenticated` or `guest`, plus the user, and exposes them through `useWorkspaceSession()` together with `openAuth()` and `signOut()`.

- **Startup.** On mount it calls `authService.session()` once. The call issues `GET /auth/session`. A 200 returns the user. A 204 means the browser holds no session cookie, so the visitor is a guest after one request. A 401 means a refresh cookie exists, so the service issues `POST /auth/refresh` once and uses the result. Network failure resolves to guest.
- **No gating routes.** Browsing never redirects to a login page. Actions that change account-bound state call `session.openAuth()`, which opens `WorkspaceShellAuthDialog` (login and register). Examples are Request Join on Agents and Send in Playground.
- **Retry once.** The agent, gateway-keys, organizations and Playground services run a call, and when it answers 401 they call `POST /auth/refresh` and repeat the call once. `agentService.listPools` is public and does not retry.
- **Cookies.** The browser only carries them. Their lifetime, rotation and storage are described in [Accounts and pools](./accounts-and-pools.md).

| State                          | Guest                                                         | Signed in                               |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------- |
| Home, Tools, Agents (browse)   | Yes                                                           | Yes                                     |
| Agents: Request Join           | Opens the auth dialog                                         | Opens the request form                  |
| Agents: Connect Agent, Hub key | Needs sign in                                                 | Yes                                     |
| Organization pages             | Sign-in call to action; sub-pages redirect to `/organization` | Overview for the default organization   |
| Playground                     | Setup shows "No providers available"; Send opens auth         | Full, see [Playground](./playground.md) |

## Data fetching

TanStack Query is the only server-state store. `createQueryClient()` (`src/utils/utils.query-client.ts`) sets `retry: false` for queries and mutations; failures surface once and the user retries.

- **Per-identity keys.** Queries that depend on who is signed in append the user id, or `"guest"`, to their key, for example `[...agentService.poolsQueryKey, session.user?.id ?? "guest"]`. They stay disabled until `session.status` leaves `loading`.
- **Key roots.** `["agent-pools"]`, `["agent-connections"]`, `["organizations"]` and `["playground"]` are the roots that `invalidateAgentQueries` touches. `["gateway-keys"]` and `["local-call-recordings"]` are separate roots that it leaves alone.
- **Cache coupling.** An organization agent is a live link to its owner's connection, so a change to one connection changes what Agents, every organization view and Playground show. `invalidateAgentQueries` (`src/utils/utils.agent-queries.ts`) invalidates all four roots after a refresh, reconnect or delete. It skips queries whose second key part is `refresh-status` or `status`, because completion polling already supplied the fresh connection and refetching it would re-trigger the completion callback.
- **Focus refetch.** The sidebar organization list and the invitation bell refetch on window focus and reconnect, except while `/playground` is open, so Playground's setup stays stable during a chat or call.

## Rendering

The app is a client-rendered SPA: `ssr: false` in `react-router.config.ts`, with `basename` taken from `VITE_BASE_PATH` (default `/`).

- **Prerendered:** `/`, `/tools`, `/agents`, `/playground`, and `/tools/<contributor>` for every contributor other than `default` that has at least one recognised tool Markdown file.
- **Everything else**, including all `/organization*` URLs, is served by the SPA shell. Nginx tries `$uri/index.html`, then `$uri`, then `/__spa-fallback.html` (`infra/nginx/default.conf.template`). See [Deployment](./deployment.md).

## Loading states

Every page renders its final layout from the first paint and fills in data as it arrives.

- Static text is real text. Values, lists and charts are `Skeleton` blocks or `animate-pulse` placeholders sized like the content that replaces them. No empty-state message appears for data that is still in flight.
- A loading region carries `role="status"` and an `sr-only` message (for example "Loading connected accounts", "Loading members", "Loading overview") and `aria-busy` where the region is a container.
- Organization pages receive `organization = null` from the layout until the session check and the organization list resolve, and render their skeletons meanwhile.
- Visible loading text is the exception. The Login button reads "Checking session…" while the session status is `loading`; the Hub key dialog shows a spinner and "Loading gateway keys…"; the Usage member filter shows "Loading member…" while `?member=` names a member the list has not returned yet. The Playground selects ("Loading providers…", "Loading accounts…", "Loading models…"), the recordings dialog and the Vosk tool's model loader also print loading text.

## Agents page

`/agents` lists every connected account as a provider-first explorer. Browsing is public.

- **Data.** `GET /agent-pools` (`agentService.listPools`) returns each connected account with its owner, members, requests, availability and usage. The server side is described in [Accounts and pools](./accounts-and-pools.md).
- **Header actions.** Install links to `/tools?node=gateway`. `AgentsGatewayKeyDialog` creates, lists and revokes Hub keys. `AgentsConnectDialog` connects a provider account.
- **Explorer** (`agents-explorer.tsx`). A provider column (`AGENT_PROVIDERS`, derived from the provider catalogue) selects one provider and shows its accounts as rows that open an account card dialog. The first provider with an account is selected by default. An All / Me / Joined filter and a text search over account label, owner username and plan narrow the list. At `lg` and wider the provider column is sticky; below that it is a wrapping row. Tooltips open after 450 ms.
- **Access state.** `agentPoolAccess(pool, username)` decides the card button:

| State      | When                                              | Button                                                                                |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `owner`    | The viewer owns the account                       | Manage, opens Manage pool access                                                      |
| `joined`   | The viewer is a member or has an accepted request | Disabled, labelled Joined                                                             |
| `pending`  | The viewer's request awaits a decision            | Disabled, labelled Request pending                                                    |
| `rejected` | The owner rejected the viewer's request           | Disabled, labelled Rejected                                                           |
| `request`  | None of the above                                 | Request Join, opens a form (Telegram username and a reason of at least 10 characters) |

- **Usage tooltip gate.** `agentProviderShowsUsage(provider)` reads `usage_metrics` from the provider catalogue. It is `true` for ChatGPT and Claude and `false` for Gemini, Grok, DeepSeek and Groq. Providers with `false` get no usage tooltip, no usage section in the account card and no usage warning.
- **Status label.** `agentPoolAvailabilityLabel` maps `active` to Active, `half_open` to Ready to retry, `rate_limited` to Cooling down and `reauth_required` to Reconnect required. An `active` account on a provider that shows usage reads Exhausted when any quota metric reports 0% remaining.
- **Reauthorization link.** When the status is `reauth_required` and the API supplied a `validationUrl`, the card shows a Verify with Google alert. Only the account owner can complete verification.
- **Manage pool access** (`agents-requests-dialog.tsx`, owner only). It lists pending requests to accept or reject, invites a member by Hub username, removes members, refreshes the credential (`AgentsCredentialRefresh`) and deletes the account. The availability tooltip comes from `GET /agent-connections/{id}`, fetched only while the dialog is open. After a refresh or reconnect the result is written into that query's cache and `invalidateAgentQueries` runs.
- **Reset credits.** For ChatGPT, usage metrics include banked reset credits. `POST /agent-connections/{id}/reset-credits` redeems one. The provider's usage endpoint lags the reset, so `agentPoolUsageAfterReset` rewrites the cached pool in place: quota windows read 100% remaining and the credit count drops by one until the next provider read.
- **Avatars.** Member avatars show initials from the API's `avatarLabel` (the first three characters of the username, first one uppercased).

## Home

`/` is a static white paper: why Hub William exists, what Agents, Tools and Playground do, and how to contribute a tool. It contains no data fetching and is prerendered.
