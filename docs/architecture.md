# Architecture

Hub William is a static single-page app plus a Supabase project. There is no
server of our own to run, and no long-lived process anywhere.

```text
Browser (React SPA on Vercel)
   │  supabase-js: authenticated reads, RLS-scoped
   │  supabase-js: functions.invoke() for actions
   ▼
Supabase
   ├── Auth ............... sessions, JWTs
   ├── Postgres + RLS ..... every table scoped to owner_id
   │     public.*  ........ readable by the owning, approved user
   │     private.* ........ service-role only; never granted to the browser
   └── Edge Functions (Deno)
         provider-connections .. connect / poll / reconnect / disconnect
         provider-sync ......... refresh one connection, or all stale ones
         jobs-sync ............. import and classify public job listings
         news-sync ............. collect, dedupe, classify and rank public feeds
         news-summarize ........ extract article text, then summarize it
                │
                ▼ HTTPS, server-side only
         auth.openai.com  +  chatgpt.com/backend-api
         Jobicy + Remotive + public ATS feeds (+ Jooble when configured)
         Grab RSS + Axon Greenhouse + NAB Eightfold
         Hacker News + Lobsters + Hugging Face + arXiv + GitHub + SEC EDGAR
         vendor blogs and status pages + Google Trends + Vietnamese news RSS
         an OpenAI-compatible chat API (only when SUMMARY_API_KEY is configured)
```

The browser never talks to OpenAI. It has no provider token and no service-role
key. Everything that touches a credential happens inside an Edge Function.

## Job-market synchronization

`jobs-sync` fetches public JSON APIs server-side, normalizes each source into a
shared posting shape, collapses repeated listings by company/title/location,
and extracts skills, seniority and minimum experience with versioned,
deterministic rules. An LLM is not required for collection or baseline parsing.

Raw upstream payloads live in `private.job_posting_payloads`; approved users can
read normalized postings and evidence-backed skills through RLS. Manual sync is
admin-only, while a scheduled request may use the existing `PROVIDER_SYNC_SECRET`.
Jooble is optional and is skipped explicitly when `JOOBLE_API_KEY` is absent.

Every connector returns a pagination audit with its upstream total (when the
source publishes one), raw and unique counts, pages fetched, duplicates, stop
reason, and a `complete` / `partial` / `unknown` coverage verdict. Offset APIs
continue until the reported total is reached and stop safely on repeated pages,
premature empty pages, or a pagination safety limit. Single-response ATS APIs
are audited as full collections; feeds and capped search APIs stay explicitly
partial or unknown.

Missing postings advance toward inactive status only after a connector proves a
complete snapshot. An incomplete or blocked sync can still refresh jobs it saw,
but it cannot make unseen jobs disappear from the dashboard.

Canonical companies and aliases keep multiple ATS names under one employer.
Each approved user owns a tracked-company watchlist. Market aggregates, Top 10
companies, selected-company requirements, and tracked-company aggregates all
share the same fixed 30-day role/location scope, but are calculated separately
so one panel cannot leak jobs into another panel's denominator.

## News collection

`news-sync` fetches about thirty public feeds server-side on the hour, folds
each into one item shape, collapses duplicates, files every item into AI, Stack
or GenZ with versioned deterministic rules, and scores it. As with the job
market, no model is involved in collection or classification.

Three decisions carry most of the design:

**Hotness is stored without a time term.** The score compares an item to its own
source's recent median and to how fast it is climbing; decay is applied when the
feed is read, by the browser and by the summarizer alike. A score with `now()`
baked into it is wrong the moment it is written, and keeping it honest would
mean a job that rewrites every row.

The age that decay is measured from is anchored to when the item was **first
seen**, not to the current run. Re-deriving it hourly would reset the age of
anything still appearing in its feed, and a source that publishes no date —
GitHub trending — would sit at the top of the page permanently.

**Every collector query pages.** PostgREST caps a response at `max_rows` (1000)
and does it silently, with a 200 and a short array rather than an error, so a
`.limit(5_000)` reads as "give me the window" and quietly returns an arbitrary
fifth of it. `fetchAllRows` in `news-sync` pages with an explicit order; the
per-source lookup asks only for the external ids the run actually saw, rather
than the source's whole history.

**Velocity is why collection runs hourly.** It is the change in an item's
attention between two consecutive snapshots, so the collection interval is the
resolution of the "happening now" half of the ranking. A daily job would only
ever see final scores.

**Duplicates collapse into a cluster.** An item joins an existing cluster when it
shares a canonical URL — tracking parameters stripped, entity families such as
`arxiv:2608.20169` and `github:owner/repo` collapsed — or when its headline
overlaps one already seen within 72 hours. The page shows one entry per cluster,
and how many other sources carry it, which is itself a signal.

Raw upstream payloads live in `private.news_item_payloads`; approved users read
normalized items through RLS. Manual collection is admin-only, and a scheduled
request uses the existing `PROVIDER_SYNC_SECRET`.

## News summarization

`news-summarize` is a separate function on a separate schedule, because it costs
money, depends on a third party, and must never be the reason the feed is empty.

Called with no body it picks the hottest unsummarized stories; called with an
`itemId` it does exactly one, which is what the story page's button sends — a
reader who opened a story wants its points now, not on the next six-hourly pass.
Either way it extracts the article body with Readability and stores that text in
`private.news_article_text` — the browser
has no grants on it, because an article fetched from the open web is a
prompt-injection carrier and the model is what reads it. Only the plain text is
kept and sent, never the HTML or markdown, so there are no links or images for
an injection to travel in.

**The model is optional.** With no `SUMMARY_API_KEY` set, extraction still
runs and each item stops at `extracted`, which is exactly the state the admin
paste form picks up. The page says so rather than showing zero summaries and
letting it read as a broken model.

**The provider is a secret, not a deployment.** Summarization speaks the OpenAI
chat-completions shape, which Groq, OpenRouter, DeepSeek and Together all
implement — and which reaches Claude too, through OpenRouter. Three secrets
choose the provider:

| Secret              | Default                          |
| ------------------- | -------------------------------- |
| `SUMMARY_API_KEY`   | none — the model step is skipped |
| `SUMMARY_API_BASE`  | `https://api.groq.com/openai/v1` |
| `SUMMARY_MODEL`     | `openai/gpt-oss-120b`            |
| `SUMMARY_REASONING` | `low` — `none` omits the field   |

Groq's free tier is the default because it needs no card. Its limits are the
constraint worth knowing: 8,000 tokens per minute and 1,000 requests per day,
against a scheduled batch of twelve articles four times daily. `SUMMARY_REASONING`
exists because reasoning models bill their thinking to the completion budget —
measured on gpt-oss-120b, the same summary cost 172 output tokens at `low` and
647 at `medium`.

Summaries are rendered as markdown that is treated as attacker-authored
throughout: no raw HTML, a tightened sanitiser allow-list, no `img` element at
all, and every link annotated with the host it points at. See
[frontend-conventions.md](./frontend-conventions.md).

## Connecting an account

The dialog is a two-step gate because the first step cannot be automated.

```text
1. "Enable Authorization"   → opens chatgpt.com/#settings/Security, unlocks step 2
2. auto-request             → POST /api/accounts/deviceauth/usercode
                              returns device_auth_id + user_code
   "Start auth"             → user opens auth.openai.com/codex/device, pastes code
   browser polls ───────────→ POST /api/accounts/deviceauth/token
                              pending … pending … authorization_code + code_verifier
   exchange                 → POST /api/accounts/oauth/token
                              access_token + refresh_token + id_token
```

Three details that shape the design:

**The browser drives the poll.** Each poll is one short Edge Function call, so
the function never blocks waiting on a human approving in another tab.

**Identity arrives before any sync.** The `id_token` carries
`chatgpt_account_id`, so a duplicate connection is detected at exchange time —
no extra API call. Reconnecting an account already present adopts the existing
row, refreshes it, and deletes the placeholder rather than creating a second one.

**Auth success and sync success are separate.** Once the credential is stored the
account is connected. A failing first sync marks it `needs_attention` and is
retried; it never strands the connection in `verifying`.

## Syncing usage

`syncCodex` issues three GETs, all pollable without spending a token:

| Endpoint                                     | Yields                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| `/backend-api/wham/usage`                    | plan, quota windows (`used_percent`, `reset_at`), credits |
| `/backend-api/wham/rate-limit-reset-credits` | `available_count` / `total_earned_count`                  |
| `/backend-api/wham/profiles/me`              | lifetime tokens, daily buckets                            |

Results normalize into provider-neutral tables: `usage_limits` (one row per quota
window), `usage_buckets` (daily totals), `provider_usage_summaries` (lifetime
counters), `provider_reset_credits`.

**Window labels are derived, not hardcoded.** A window is named from
`limit_window_seconds` — 300 → "5h limit", 10080 → "Weekly limit". Real accounts
have been observed with only a weekly window and `secondary_window: null`, so
assuming "primary = 5h" would mislabel them.

**Rotated refresh tokens persist immediately.** OpenAI invalidates the presented
refresh token on rotation. If the new one were only saved at the end of a
successful sync, a single failed request would strand the account permanently, so
`syncCodex` takes a `persistCredential` callback fired the moment a refresh
succeeds.

## Credentials

| Secret                               | Where it lives                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| ChatGPT access + refresh token       | `private.provider_credentials`, AES-GCM encrypted                                |
| `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` | Edge Function secret — **losing it makes every stored credential undecryptable** |
| `PROVIDER_SYNC_SECRET`               | Edge Function secret; the `x-sync-secret` header on scheduled syncs              |
| Supabase publishable key             | Public by design; safe only because RLS is the real boundary                     |

The `private` schema has no browser grants at all. It is reached only through
`security definer` functions that assert `auth.role() = 'service_role'`.

## Data flow into the UI

`getWorkspaceUsage()` runs four parallel queries — connections, limits,
summaries, reset credits — plus daily buckets bounded to 35 days. Aggregation
happens in `normalizeWorkspaceUsage()`, a pure function, which is what the
service tests exercise.

Two deliberate choices:

**Only `connected` and `needs_attention` rows are fetched.** A `verifying` row is
an in-flight sign-in that was never approved; abandoning the dialog deletes it.

**Account totals come from `lifetime_tokens`, not from summing buckets.** That is
why the 35-day bucket window does not truncate the all-time figure — the two
numbers come from different tables and must never be added together.

## Scheduled refresh

`provider-sync` accepts a scheduled call carrying `x-sync-secret` and refreshes
every non-collector connection whose `last_synced_at` is older than 15 minutes.
`pg_cron` runs it daily; the schedule ships in a migration and reads both the
endpoint and the secret from Vault, so nothing project-specific is committed and
the one manual step is seeding those two secrets.

The daily run is also the only thing that notices a Codex account whose OAuth
session OpenAI has ended. The sync path refreshes on 401 rather than only on the
recorded expiry — a Codex access token is issued for ten days, so the clock
alone would leave a repudiated account broken for a week — and records
`needs_attention` with the reason once even the refresh token is gone.
