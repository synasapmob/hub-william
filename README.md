# Hub William

A private dashboard for William and approved friends to track **ChatGPT (Codex)
usage quota, limits, and reset times** in one place.

Connect a ChatGPT account by signing in with OpenAI's device-code flow — no CLI,
nothing to install — and the dashboard polls its quota server-side.

Four authenticated pages:

- **Overview** — tokens this week, week-over-week change, tracked volume, and
  per-account share.
- **Agents** — one row per connected ChatGPT account: plan, quota used, reset
  countdown, available reset credits, last sync, refresh and disconnect.
- **Jobs** — engineering openings and demand signals from a fixed company list.
- **News** — what is hot right now across AI, the wider stack, and Gen Z
  culture, collected hourly from public feeds and summarized into main points.

There is no sample data. Values a ChatGPT subscription does not report — cost,
model breakdown — are rendered as unavailable rather than estimated.

📖 [Overview](docs/overview.md) · [Architecture](docs/architecture.md) ·
[Technology choices](docs/technology-choices.md) ·
[Frontend conventions](docs/frontend-conventions.md)

## Stack

- React 19 + TypeScript + Vite 8
- React Router 8 (framework mode, SPA) + TanStack Query
- Tailwind CSS 4 + shadcn/ui + tailwind-variants
- Supabase Auth, Postgres migrations, and Row Level Security
- Supabase Edge Functions for provider authorization and synchronization
- Highcharts
- Vitest + Testing Library + Oxlint + Prettier

## Supabase setup

Create a Supabase project, then link this repository and apply its migrations:

```bash
pnpm dlx supabase@latest login
pnpm dlx supabase@latest link --project-ref YOUR_PROJECT_REF
pnpm dlx supabase@latest db push
```

In Supabase Dashboard, open **Authentication → Providers → Email** and disable
**Confirm email**. New registrations are signed out immediately and must still be
approved manually.

Create `.env.local` from `.env.example`:

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

The publishable key is intentionally browser-visible. Never use a secret,
service-role key, provider key, or OAuth token in a `VITE_` variable.

## Approval flow

1. A friend registers at `/register`.
2. The database trigger creates `public.profiles` with `status = 'pending'` and
   `role = 'member'`.
3. In Supabase Table Editor, open `profiles` and change that row's status to `approved`.
4. `approved_at` is set automatically by the migration trigger.
5. The friend can now log in at `/login`.

The app checks approval after authentication. Usage tables are read-only from the
browser and protected by owner-scoped RLS policies.

## Roles

`status` decides whether the workspace opens; `role` decides what can be done
inside it. Change a role the same way you approve one — edit the `profiles` row
in Supabase Table Editor.

| Role        | Gateway API keys  | Everything else |
| ----------- | ----------------- | --------------- |
| `admin`     | Create and revoke | Full access     |
| `moderator` | No                | Full access     |
| `member`    | No                | Full access     |

A gateway key proxies to every connected account and bills them, so minting one
is an owner's decision rather than a dashboard feature. It is refused in three
places: the button is not drawn, the Edge Function answers 403, and
`store_gateway_key` raises if the owner is not an approved admin.

`moderator` has no privilege of its own yet. It exists in the enum so the middle
rung is there when something needs it, and it shows as a badge in the account
menu.

The migration that adds roles promotes the **first registered profile** to
`admin` — every other profile exists because that person approved it. If that is
not you, set the right row to `admin` in Table Editor; until one exists, nobody
can create a key.

## Prompt privacy

The hub records that a prompt ran — when, how long it was, which slash command
started it, which model spent the most tokens on it — and never what it said.
Prompt text is not read out of the telemetry payload, so turning
`OTEL_LOG_USER_PROMPTS` on in a project changes nothing that reaches the
database. Grok Build additionally hands its hooks the full prompt and a path to
the conversation on disk; the hub's hook copies three fields and neither of
those is among them.

This is deliberate rather than a display choice. A prompt is whatever was typed
or pasted at a terminal, so one paste of an API key would otherwise sit in
Postgres and in every backup taken since.

## Tracked projects

Codex, Claude Code and Grok Build are configured once per machine, in
`~/.codex`, `~/.claude` and `~/.grok`. All three report every folder they run
in, and **Tracked projects** on the Agents page decides which of those are kept.
Adding a repository is a row in that list, never a file next to the code.

The list is an opt-in. While it is empty nothing is collected at all; a folder
that is not on it produces no project, no usage, and no row of any kind, because
the check runs before the first write rather than after it. A repository is
recorded because someone named it, and for no other reason.

The list matches the last segment of the working directory, ignoring case, so
`hub-william` matches wherever that repository is checked out — including its
git worktrees, which resolve to the repository rather than to the worktree
directory. A session started in a subdirectory still reports the repository.

Two different checkouts that share a folder name share the entry. Codex and Grok
Build keep them as separate cards, because their rows are keyed by a digest of
the full path; Claude Code merges them into one, because its telemetry
identifies a project by name alone. Give one of them a distinct folder name if
that matters.

A folder is matched from the directory the agent was **started** in. Running an
agent from a parent directory attributes everything to that parent, whatever it
touches underneath.

## Backend setup

Configure Edge Function secrets:

```bash
openssl rand -base64 32   # PROVIDER_CREDENTIAL_ENCRYPTION_KEY
openssl rand -hex 32      # PROVIDER_SYNC_SECRET

pnpm dlx supabase@latest secrets set \
  APP_URLS=https://hub-william.site,http://localhost:5173 \
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY=THE_GENERATED_32_BYTE_BASE64_KEY \
  PROVIDER_SYNC_SECRET=THE_GENERATED_SCHEDULER_SECRET
```

Deploy the connection functions and the telemetry collectors:

```bash
pnpm dlx supabase@latest functions deploy provider-connections --no-verify-jwt
pnpm dlx supabase@latest functions deploy provider-sync --no-verify-jwt
pnpm dlx supabase@latest functions deploy codex-otel --no-verify-jwt
pnpm dlx supabase@latest functions deploy claude-otel --no-verify-jwt
pnpm dlx supabase@latest functions deploy grok-otel --no-verify-jwt
pnpm dlx supabase@latest functions deploy news-sync --no-verify-jwt
pnpm dlx supabase@latest functions deploy news-summarize --no-verify-jwt
```

The functions perform their own approved-user authorization. ChatGPT
authorizations are encrypted with AES-GCM before being written to a private
database schema that has no browser grants.

> **Back up `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`.** Changing or losing it makes
> every stored connection undecryptable, and each account must be reconnected.

## Connecting a ChatGPT account

**Before connecting, enable the setting OpenAI ships turned off.** In ChatGPT,
open [Settings → Security](https://chatgpt.com/#settings/Security) and turn on
**Enable device code authorization for Codex**. While it is off, approving a code
silently does nothing and the sign-in expires — nothing in the API reports the
toggle's state, so the app cannot check it for you.

Then open **Agents → Connect account**:

1. **Enable Authorization** — opens the security settings page.
2. A one-time code appears. **Copy code**, then **Start auth** to open OpenAI.
3. Choose the account, paste the code, approve.

The dialog closes itself once approved and the account names itself from the
ChatGPT address you signed in with. Connecting an account that is already present
refreshes it instead of creating a duplicate.

### What is imported

| Imported                                                         | Not available                                     |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| Plan type, quota windows with used percentage and reset time     | Dollar cost — a subscription reports none         |
| Available and earned limit-reset credits                         | Model-level attribution — Codex reports one total |
| Lifetime tokens, peak daily tokens, streaks, daily token buckets | Anything requiring a model request                |

The app never accepts a ChatGPT password, OTP, cookie, or pasted token. The
browser never receives a provider credential.

## Connecting Grok Build

There is no account to connect and no quota to poll. Open **Agents → Add agent →
Grok Build** and follow the three snippets: a shell wrapper for `~/.zshrc`, a
hook script, and a hook config for `~/.grok/hooks/`.

Grok Build needs more setup than Claude Code for two reasons, both upstream:

**Its exporter speaks only `http/protobuf` or `grpc`.** An unrecognized
`OTEL_EXPORTER_OTLP_PROTOCOL` disables the stream silently rather than falling
back, so the `http/json` that `claude-otel` reads is not an option and
`grok-otel` decodes protobuf instead.

**Its usage records carry no session id.** `grok_code.api_request` reports the
model and the token counts and nothing that identifies the session, prompt, or
folder — `session.id` appears only on `session_start`, and
`OTEL_METRICS_INCLUDE_SESSION_ID` does not add it. So the shell wrapper mints a
run id per launch and puts it in the reporting URL, where it survives into every
export; the hook reports the same id with the folder it is running in, and the
collector joins the two. That wrapper is what makes per-project totals possible.

Launch Grok some other way and its usage is still recorded, but as an unlabelled
project rather than the right repository.

### What is imported

| Imported                                             | Not available                                      |
| ---------------------------------------------------- | -------------------------------------------------- |
| Input, output, cached and reasoning tokens per model | Dollar cost — Grok publishes no price in telemetry |
| Requests and prompt counts per project and hour      | Quota, limits and reset times — none are reported  |

Reasoning tokens are stored in their own column and deliberately left out of the
token total: Grok reports them as a breakdown of output tokens rather than as a
separate charge, so adding them would inflate every reasoning turn.

## Synchronization

Each connection imports on creation, and the Agents table has a refresh button.

Automatic updates run themselves: a migration enables `pg_cron` and `pg_net` and
schedules `provider-sync` daily at 02:00 UTC. The job takes both the endpoint and
the `x-sync-secret` value from Vault rather than embedding them, so the schedule
is committable and nothing project-specific is. Seed the two secrets once:

```sql
select vault.create_secret(
  'https://YOUR_PROJECT.supabase.co/functions/v1/provider-sync',
  'provider_sync_url'
);
select vault.create_secret('YOUR_PROVIDER_SYNC_SECRET', 'provider_sync_secret');
```

Until both exist the job wakes up, warns, and posts nothing. The endpoint
refreshes connections whose last sync is older than 15 minutes, skipping
`collector` connections — those push their own telemetry and hold no credential
to sync with.

The news feed schedules itself the same way, reusing `provider_sync_secret` so
there is only one scheduler secret to rotate. Seed its two URLs:

```sql
select vault.create_secret(
  'https://YOUR_PROJECT.supabase.co/functions/v1/news-sync',
  'news_sync_url'
);
select vault.create_secret(
  'https://YOUR_PROJECT.supabase.co/functions/v1/news-summarize',
  'news_summarize_url'
);
```

Collection runs at five past every hour. The hourly cadence is load-bearing
rather than enthusiasm: an item's velocity is the change in its score between
two consecutive collections, so the interval is the resolution of the "happening
now" half of the ranking.

## Summarizing the news

The summarizer is optional, and the feed works without it.

Set `ANTHROPIC_API_KEY` and `news-summarize` writes the main points of the
hottest stories itself, on Claude Haiku, six-hourly:

```bash
pnpm dlx supabase@latest secrets set ANTHROPIC_API_KEY=sk-ant-...
```

Every story page also has a **Summarize this story** button, which reads that
one article and writes its points there and then rather than waiting for the
next scheduled pass.

Leave the key unset and the function still fetches and extracts each article,
stops at `extracted`, and says so — the story page then offers a
paste-and-preview editor instead, which renders through the same component and
sanitiser the published page uses.

At sixty stories a day this costs roughly $7 a month. That number is the reason
the automated path exists at all: the alternative is a copy-and-paste chore
performed every morning, forever, to save the price of a coffee.

**Do not point this at a ChatGPT subscription through the hub's own gateway.**
It would be free and it would work. OpenAI's terms prohibit programmatic
extraction of output outside the API, the Codex entitlement is scoped to Codex,
and an unattended nightly job summarizing news is precisely the pattern that is
prohibited. The penalty is account-level, and it would take every connected
account on the Agents page with it.

## Run locally

```bash
pnpm install
pnpm dev
```

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck        # src + supabase/functions
pnpm test
pnpm build
```
