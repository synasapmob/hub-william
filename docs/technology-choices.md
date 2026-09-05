# Technology choices

Every entry answers the same question: _why this, given a private dashboard with
a handful of users and one maintainer?_ The recurring theme is **avoid operating
anything**.

## Platform

### Supabase — database, auth, and backend in one

Needed: a Postgres database, user accounts, per-user data isolation, and
somewhere to run code holding OAuth tokens. Supabase supplies all four.

- **Postgres, not a document store** — usage data is relational (accounts →
  limits, buckets, summaries) and the aggregations are joins and sums, which SQL
  does well.
- **Row Level Security is the authorization boundary.** Policies live next to the
  data, so a forgotten check in a component cannot leak another user's rows.
  Route guards are navigation polish only.
- **Edge Functions remove the need for a server.** Token exchange and refresh
  must happen somewhere the browser cannot see. Functions give that without a
  container, a host, or a deploy pipeline to babysit.
- **Migrations are version-controlled SQL**, applied with `supabase db push`.

_The alternative — self-hosting Postgres plus an API server plus a job runner —
means TLS, backups, patching, and uptime for a dashboard one person reads. All
cost, no benefit._

_Trade-off:_ vendor lock-in is real. RLS policies and `security definer`
functions are Postgres-portable; Edge Functions and Auth are not.

### Vercel — static hosting

The app builds to static files. Vercel serves them with a SPA fallback and
deploys on push. No server rendering: every page needs an authenticated session
and live provider data, so there is nothing meaningful to render ahead of time.

## Frontend

### React Router 8 (framework mode, SPA)

Routing, layouts, and code splitting from file names. The `_app` / `_auth`
pathless layouts give two different auth boundaries without polluting URLs — see
[frontend-conventions.md](./frontend-conventions.md).

_Why not Next.js:_ its strengths are SSR, server components, and edge middleware.
An authenticated, data-live dashboard uses none of them, and Supabase already
covers the server-side needs.

### TanStack Query — server state

Usage data is remote, cached, refetched, and invalidated after mutations. Query
handles staleness, deduplication, and background refresh; without it the same
logic reappears by hand in every component. It is also what lets the connect
dialog poll on OpenAI's requested interval declaratively.

### Tailwind CSS 4 + shadcn/ui + tailwind-variants

- **Tailwind** — styling stays in the markup; no separate stylesheet to keep in
  sync with a component's lifetime.
- **shadcn/ui** — accessible Radix primitives copied _into_ the repo rather than
  installed. Focus management, portals, and keyboard behaviour are solved, and
  the code is editable.
- **tailwind-variants** — for app-owned variant sets (status tones, marks), so
  variants stay declarative instead of becoming conditional string building.

### Highcharts

The overview combines grouped token columns with a request spline on a second
axis, plus a donut for per-account share. Highcharts provides those mixed chart
types, responsive rules, polished interaction, and keyboard-friendly chart
navigation without maintaining custom SVG primitives.

### TypeScript, Vitest, Oxlint, Prettier

TypeScript matters most at the **service boundary** — undocumented provider JSON
is parsed into typed rows, and the compiler catches drift when a shape changes.

Vitest tests `normalizeWorkspaceUsage`, a pure function, which is where the real
logic lives. Oxlint is a fast Rust linter; Prettier ends formatting arguments.

## Provider integration

### ChatGPT device-code OAuth

The Codex OAuth client is registered against a **localhost** redirect
(`http://localhost:1455/auth/callback`) — which is why Codex CLI and similar
tools all run something on your machine to catch the callback. A hosted web app
cannot receive it, and OpenAI does not offer client registration for ChatGPT
subscription access.

The device-code flow is the way out: the server requests a code, the user
approves it on OpenAI's page, and the server polls for the token. No localhost,
no installed software.

_The alternative — shipping a CLI — was built and then deleted._ It worked, but
it made a browser dashboard depend on the user installing and running a local
process. Device code removes that entirely.

### Reading quota, not proxying it

Quota comes from dedicated usage endpoints, so nothing is inferred from traffic
and no model request is ever made.

_The alternative — a local routing proxy (9Router-style)_ — would mean
intercepting Codex traffic, pooling accounts, and impersonating a first-party
client. That is squarely against OpenAI's terms on circumventing rate limits, it
requires defeating originator allow-lists and client attestation, and it breaks
constantly. Reading your own account's quota is a different activity: it evades
no limit, adds no load, and duplicates a view OpenAI already ships at
`chatgpt.com/codex/settings/usage`.

### Why ChatGPT only, and why not Anthropic

Anthropic deliberately closed this door: server-side client-identity checks
reject consumer OAuth tokens outside Claude Code, the legal terms were updated to
prohibit it explicitly, and enforcement is in place. Several third-party tools
lost access.

OpenAI went the other way — it publishes a plugin letting _Claude Code_ consume a
ChatGPT subscription. That difference in posture, not a difference in effort, is
why this app tracks ChatGPT and not Claude.

Anthropic **API organization** usage is available via an Admin key and is a
legitimate future addition. It is a different product from a Claude Pro/Max
subscription, and would not give per-plan quota or resets.

## Deliberately not used

| Not used                          | Why                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Redux / Zustand                   | Nearly all state is server state; TanStack Query owns it. Local UI state is small and component-scoped.     |
| An ORM                            | Migrations are plain SQL and queries go through `supabase-js`. A second schema definition would only drift. |
| A component library (MUI, Chakra) | shadcn gives accessible primitives without inheriting a theme system to fight.                              |
| SSR                               | Every page is authenticated and live. Nothing useful renders ahead of time.                                 |
| A self-hosted API server          | Edge Functions cover the few operations needing secrets.                                                    |
