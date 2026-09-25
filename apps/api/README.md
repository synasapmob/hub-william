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

The optional `apps/api/scripts/smoke-local-railway.sh` writes synthetic rows
to the linked Railway database and attempts to delete them on exit. It requires
a local SSH key registered with Railway (`railway ssh keys add`) and opens a
private local tunnel with `railway connect Postgres --tunnel-only`. A public
Postgres TCP Proxy is not needed for this script. Check the linked project and
environment before running it; do not use the production database for routine
tests.

## Live routes

- `/auth/*`: five-hour access session and rotating seven-day refresh session.
- `/agent-connections/*`: official provider authorization start, poll, callback,
  DeepSeek API-key connection, disconnect, and refresh-on-read lifecycle.
- `/gateway-keys`: create-once, list metadata, and revoke operations.
- `/organizations` and `/organization-invitations`: multiple teams, invitations,
  member lists, connected-agent shares, overview and usage. Accepted membership
  is required for organization reads and agent use. Owners manage invitations
  and may remove any shared agent; members may share their own connected
  agents and remove their own shares. Organization descriptions are optional
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
- `/gateway/openai/v1/responses`: Codex/OpenAI Responses streaming gateway.
- `/gateway/claude/v1/messages`: Claude Messages streaming gateway.
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
persists a 30-minute cooldown, while an upstream `401` marks that account for
reauthorization. A Grok `403` does the same because expanded subscription
scopes require an explicit reconnect. These failures advance to the next
same-provider pool. An AGY/Code Assist `403` also advances to the next Gemini
pool for the current request, without assuming that reconnecting fixes an
account, project or model permission failure. An explicit `Verify your account
to continue.` response instead marks only that AGY pool for reconnection before
trying the next account. A malformed `400` remains
visible to the caller. Browser Playground requests stay pinned to the
explicitly selected account. Before any response is returned to the client,
network failures and upstream `408`, `500`, `502`, `503`, and `504` responses
use one four-attempt budget across all same-provider pools with bounded
exponential backoff; partial streams are never combined with a retry. The
first real request after a rate-limit timer is an atomic half-open probe. An
owner can force-refresh the provider credential from pool management; a
rejected or missing refresh token starts official authorization again on the
same pool record. The API also refreshes connected OAuth provider credentials after 60
minutes without rotation, isolating per-account failures so one stale pool
cannot stop the remaining sweep. Around 00:00 Vietnam time, it checks every
connected credential not already checked that local day: OAuth credentials are
rotated, while static DeepSeek keys are validated. A restart catches up missed
nightly checks. Accounts with rejected credentials need manual reconnection;
the background sweeps cannot log in for them. Provider credential payloads are
AES-256-GCM encrypted. Do not log request authorization headers, API keys,
OAuth codes, device codes, callback URLs, or provider response bodies.

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
