# Backend

Rust control-plane and streaming gateway service for Hub William. It owns
username/password registration, rotating PostgreSQL-backed browser sessions,
ChatGPT/Claude/Gemini/Grok authorization, encrypted DeepSeek API keys and
provider credentials, user-scoped
gateway keys, organizations, runtime health, and generated OpenAPI documentation. Pool
persistence, join requests, and private Telegram contacts, orders and payments
are live; pool cards read live provider usage. Post-payment fulfilment remains a
later change.

Account pools have no member-count limit: owners can invite or approve members
regardless of the current total. The legacy `capacity` response field and database
column remain for compatibility and no longer limit sharing. Membership totals
include the owner and accepted members; approval and duplicate protections remain.

```bash
cargo run --manifest-path apps/api/Cargo.toml
```

- Health: `http://localhost:8080/health`
- OpenAPI: `http://localhost:8080/api-docs/openapi.json`
- Swagger UI: `http://localhost:8080/docs`

Copy `.env.example` into your local secret manager or run through Railway so
`DATABASE_URL` is available. The binary applies SQLx migrations before it starts
listening. `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` must be an unpadded URL-safe
base64 encoding of exactly 32 random bytes. `GEMINI_OAUTH_CLIENT_SECRET` must
contain the AGY OAuth client credential and must remain in the runtime secret
store; it is sent for both authorization-code exchange and token refresh.
`PORT` defaults to `8080`;
`FRONTEND_ORIGIN` restricts credentialed browser requests and
`COOKIE_SECURE=true` enables secure cookies for production. Keep all
populated values in the runtime secret store.

## Rate limiting

Requests are limited in memory, per process, with one token bucket per route
group: `30/min` lets 30 requests arrive at once and then refills one every two
seconds. Every number lives in `Limit::per_minute` in `src/api/limits.rs`, and
each feature attaches its limiter in its own `routes.rs`. Over the limit the
API answers `429` with a `Retry-After` header and
`{ "code": "rate_limited", "message": ... }`.

- Public routes (`/auth/login`, `/auth/register`, `/reel/*`, `/tts`) are keyed by
  client IP. IPv6 clients are grouped by `/64`; a request with no usable IP
  shares one bucket.
- Signed-in routes (agent connections and pools, organization writes,
  `/auth/refresh`, gateway-key management, the playground) are keyed by user.
- `/gateway/*` is keyed by gateway key. Failed key attempts are also counted per
  IP, and an IP that keeps failing gets `429` before the key is even checked.

The client IP is the socket peer unless `TRUST_PROXY_HEADERS=true`, which reads
the address from `CLIENT_IP_HEADER` (default `x-real-ip`). Only enable it behind
a proxy that overwrites that header, or callers can pick their own bucket. With
it off behind a proxy, all clients share the proxy's address and therefore one
bucket, so confirm the header on the deployed environment before relying on it.
With several replicas each one counts separately.

The optional `apps/api/scripts/smoke-local-railway.sh` writes synthetic rows
to the linked Railway database and attempts to delete them on exit. It requires
a local SSH key registered with Railway (`railway ssh keys add`) and opens a
private local tunnel with `railway connect Postgres --tunnel-only`. A public
Postgres TCP Proxy is not needed for this script. Check the linked project and
environment before running it; do not use the production database for routine
tests.

## Source layout

Code is grouped by layer, and every endpoint feature has its own folder, so
features can be added or extracted without touching each other.

```text
src/
  lib.rs            crate root: the public surface main.rs and the examples use
  main.rs           the server binary
  core/             config, ApiError, AppState, CORS; imports nothing else
  utils/            shared leaf code with no endpoints; depends on core only
    provider_catalogue/   reviewed provider/model metadata (+ catalogue.json)
    tts/                  the Edge TTS engine
    database.rs           database_error(scope, error)
  api/              every feature with endpoints, plus the composition root
    mod.rs  router.rs  openapi.rs     the only files that list features
    health/  auth/  agent/  gateway/  organizations/  playground/  telegram/  tts/
```

- Dependencies point one way: `api` -> `utils` -> `core`. `core` never imports
  `utils` or `api`, and `utils` never imports `api`.
- A feature's `mod.rs` is its public face; its submodules stay private and other
  features import only what `mod.rs` re-exports.
- A feature wires itself in from its own `routes.rs`: `routes()` for its
  endpoints and an `...Api` struct for its OpenAPI fragment. Adding a feature is
  a new folder under `api/` plus one line each in `router.rs` and `openapi.rs`.
- Code with an endpoint lives in `api/`. Reusable logic with none goes in
  `utils/`; `tts` is split that way: the engine in `utils/tts`, the `POST /tts`
  handler in `api/tts`.
- `agent/` holds provider connections, account pools and provider usage.
- Database-backed tests sit beside their code in `database_tests.rs` and run
  with `--features database-tests`.

## Live routes

- `/auth/*`: five-hour access session and rotating seven-day refresh session.
- `/agent-connections/*`: official provider authorization start, poll, callback,
  DeepSeek API-key connection, disconnect, refresh-on-read lifecycle, and
  owner-only redemption of the ChatGPT account's banked reset credits.
- `/gateway-keys`: create-once, list metadata, and revoke operations.
- `/organizations` and `/organization-invitations`: multiple teams, invitations,
  member lists, connected-agent shares, overview and usage. Accepted membership
  is required for organization reads and agent use. Owners manage invitations
  and may remove any shared agent; members may share their own connected
  agents and remove their own shares. `DELETE /organizations/{id}` lets the
  owner delete the organization with its memberships, agent links and usage;
  `DELETE /organizations/{id}/membership` lets a member leave, and an owner
  cannot. `PUT /organizations/{id}/default` makes an organization the caller's
  default (`is_default` on every organization they read); creating or joining
  one does the same, and leaving or deleting it clears it.
  `GET /organization-summaries?days=` adds each organization's owner, agent and
  member counts and recorded usage for the My organizations table.
  Organization descriptions are optional
  and limited to 350 characters. The agent list accepts
  `include_usage=true` to fetch live provider quota metrics for supported
  providers in the Agents explorer; ordinary account choices do not trigger
  provider usage reads.
- `GET /playground/{provider}/accounts/{connection_id}/models`: live models for
  an account the signed-in user owns, a pool they have joined, or an agent
  shared with an accepted organization when `organization_id` is supplied.
- `POST /playground/chat`: session-authorized, account-pinned text streaming;
  accepts supported image and file inputs but does not generate native images.
  `organization_id` selects an accepted organization's shared account.
- `POST /playground/voice`: session-authorized, account-pinned Codex Voice
  session setup. Accepts an audio-only SDP offer up to 64 KiB and returns the
  SDP answer without exposing provider credentials. Audio and native transcripts
  flow over browser WebRTC; the camera remains a local preview. No automatic
  session replay. Organization usage counts successful session setups with
  unknown tokens. See [ADR-0032](../../docs/decisions/0032-playground-native-voice.md).
- `/gateway/openai/v1/responses`: Codex/OpenAI Responses streaming gateway.
- `/gateway/claude/v1/messages`: Claude Messages streaming gateway.
- `/gateway/openai/v1/models`, `/gateway/claude/v1/models`: the models the key
  owner's connected account lists live, intersected with the current catalogue
  for names and effort metadata. A model the subscription lacks is never offered
  to key clients such as OpenCode and OMP.
- `/gateway/gemini/v1beta/models`: the current public AGY model set intersected
  with the connected Google Code Assist subscription's live catalogue.
- `/gateway/gemini/v1beta/models/*`: AGY native Gemini generation protocol
  bridged to the connected Google Code Assist subscription.
- `/gateway/grok/v1/*`: Grok Build Responses, chat-completions compatibility,
  and authenticated live model catalogue gateway.
- `/gateway/deepseek/*`: DeepSeek OpenAI-compatible chat, Responses, and live
  model-list gateway.
- `/internal/telegram/*`: contacts, their language preference, their orders, and
  SePay bank transactions. Reachable only over Railway private networking and
  only with `TELEGRAM_SERVICE_TOKEN`; never exposed through the frontend proxy.

A Telegram order is created with a unique reference and settles when a SePay
transfer arrives whose note contains that reference and whose amount covers the
total. Matching takes the row `FOR UPDATE SKIP LOCKED`, so two transfers landing
together cannot settle the same order, and `telegram_payments` is unique by
SePay's transaction id, so a retried webhook is recorded once. A transfer that
matches nothing is still stored for manual reconciliation.

Organization Usage records successful generation responses selected through an
organization. It shows request counts and provider-reported input/output tokens;
requests without complete token reports remain in the count with unknown tokens.
Cached input is included in input tokens. Personal requests and earlier traffic
are not retroactively attributed. Organization gateway-key creation remains a
separate decision; existing personal keys keep their current access.

Gateway keys are shown once and stored only as hashes. A key can route through
every connected account the user owns and every pool where their join request
is accepted. Candidate pools are filtered strictly by the requested provider;
an unusable credential advances to the next candidate. An upstream `429`
persists a 30-minute cooldown. An upstream `401` (and a Grok `403`) first
refreshes the credential, or picks up the token another request already
rotated in, and retries the same account once. The account is marked for
reconnect only when the provider rejects its refresh credential or also rejects
the fresh token; that mark is compare-and-set against the rejected token and
logged. Other `403` responses and a `402` (such as a DeepSeek account without
balance) advance to the next same-provider account; an
AGY/Code Assist `403` does so without assuming that reconnecting fixes an
account, project or model permission failure. An explicit `Verify your account
to continue.` response instead marks only that AGY pool for reconnection before
trying the next account. A malformed `400` remains visible to the caller.

Browser Playground requests treat the selected account as the preferred first
candidate and fail over within their own scope: the user's accounts and joined
pools, or only the selected organization's shared agents. A successful response
names the serving account in `x-hub-connection-id`. Before any response is
returned to the client, network failures and upstream `408`, `500`, `502`, `503`,
and `504` responses share one attempt budget of `max(4, accounts in scope)`
with bounded exponential backoff, so every account gets a turn; partial streams
are never combined with a retry. The first real request after a rate-limit
timer is an atomic half-open probe.

An owner can force-refresh the provider credential from pool management or from
a linked organization agent; a rejected or missing refresh token starts official
authorization again on the same pool record. The API also refreshes every
connected OAuth credential 30 minutes after its previous refresh, from a stored
`next_refresh_at`, whether or not it is used. A refresh token that the provider
reports will expire sooner is refreshed five minutes before it does. A scheduled
refresh that fails on the network or provider availability is tried once more
after three seconds (two attempts in all) and otherwise waits for its next
regular refresh; a refresh token the provider rejects fails at once and is not
retried. The same sweep retries accounts the
gateway marked for reconnect, and accounts whose old reconnect prompt expired,
restoring them when a refresh succeeds. Per-account failures are isolated so one
stale pool cannot stop the remaining sweep. Around 00:00 Vietnam time, it checks
every connected credential not already checked that local day: OAuth credentials
are rotated, while static DeepSeek and Groq keys are validated. A restart catches
up missed nightly checks. Request traffic reads credentials without a row lock
unless they are about to expire, every refresh runs in its own task so a dropped
request cannot lose a rotated token, and SIGTERM stops the sweep from starting
another account while refreshes already talking to a provider commit (up to 25
seconds after open requests drain) before the process exits. Accounts whose refresh credential is rejected
need manual reconnection; the background sweeps cannot log in for them.
Provider credential payloads are AES-256-GCM encrypted. Do not log request
authorization headers, API keys, OAuth codes, device codes, callback URLs, or
provider response bodies.

## Operator credential refresh

With the target runtime's database URL, encryption key and provider configuration
in the process environment, refresh every connected account explicitly:

```bash
cargo run --locked --manifest-path apps/api/Cargo.toml --example refresh_provider_credentials -- --all
```

This reuses the normal credential row locks and provider refresh implementation,
validates DeepSeek keys, probes AGY's Code Assist model, token-count and minimal
generation endpoints for an explicit account-verification challenge, and prints only
connection IDs, providers and outcomes.
One failure does not stop the remaining accounts. Expired or rejected refresh
tokens are marked for reauthorization without creating login prompts; reconnect
those pools through the UI. OAuth client-configuration errors remain failures
instead of being mislabeled as expired account credentials. A nonzero exit
means at least one account could not refresh or the batch could not complete.
This command neither applies migrations nor merges accounts.

The reconnect and batch-refresh database regressions use SQLx-created test
databases. Point `DATABASE_URL` at an isolated local PostgreSQL instance with
database-creation privileges, then run
`cargo test --manifest-path apps/api/Cargo.toml --features database-tests`.
Provider HTTP responses in these tests are local fixtures; never use production
credentials or a production database for this command.

ChatGPT connections are identified by the personal token subject (or normalized
email when a subject is absent), never by the shared ChatGPT workspace ID alone.
Legacy cached workspace identities are recomputed when matching connections.
Distinct logins in the same workspace keep separate pools; reconnecting the same
login refreshes its existing pool and transfers ownership to the connecting user.

### Groq Chat and Call

Connect with `POST /agent-connections/groq` and a user-supplied `api_key`.
`GROQ_API_URL` defaults to `https://api.groq.com/openai/v1`. Credentials follow
DeepSeek's encryption, sharing and static-key refresh rules. Groq is separate
from Grok. Gateway Chat endpoints are `/gateway/groq/v1/models`,
`/gateway/groq/v1/responses`, and `/gateway/groq/v1/chat/completions`.

`POST /playground/groq/voice/turn` accepts session-authenticated, account-pinned
`transcript` text plus bounded conversation history. Speech recognition runs in
the browser; the API composes GPT-OSS 20B and Orpheus English only. Current text
is limited to 8,000 UTF-8 bytes with at least one letter or number, and the body
is limited to 64 KiB. Audio input and the former `/voice/transcription` route
are removed. See [ADR-0037](../../docs/decisions/0037-browser-local-speech-recognition.md).

With `stream: true`, the turn returns SSE `transcript`, `delta`, `audio`, `done`
or sanitized `error` records. Groq reply deltas arrive before TTS completes;
disconnect cancels upstream work while retaining bounded account cleanup.
Omitting `stream` retains the JSON response. See
[ADR-0034](../../docs/decisions/0034-playground-call-streaming-and-interruption.md).
