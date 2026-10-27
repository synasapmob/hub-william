# Accounts and pools

This document covers the API side of identity and provider accounts: Hub sessions, the provider accounts a user connects, the pools other users join, availability, the credential refresh lifecycle, and Hub keys. How a request is routed across accounts is in [gateway](./gateway.md), organization sharing is in [organizations](./organizations.md), and the pages that drive these endpoints are in [frontend](./frontend.md). The threat model for stored credentials is in [ADR-0001](../decisions/0001-provider-oauth-and-user-scoped-gateway.md).

Terms: a **connection** is one connected provider account (a row in `agent_connections`). A **pool** is a connected connection seen from outside: its owner plus the users whose join request is accepted. A **Hub key** is the bearer secret (`hw_live_…`) that local agents send to the gateway.

## Code map

| Area                             | Location                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sessions, register, login        | `apps/api/src/api/auth/mod.rs`                                                                    |
| Connect flows, refresh, marks    | `apps/api/src/api/agent/connections.rs`                                                           |
| Pools, join requests, membership | `apps/api/src/api/agent/pools.rs`                                                                 |
| Provider usage and reset credits | `apps/api/src/api/agent/usage.rs`                                                                 |
| Hub keys (`create_key`)          | `apps/api/src/api/gateway/mod.rs`                                                                 |
| Rate-limit policy                | `apps/api/src/api/limits.rs`, `apps/api/src/core/rate_limit.rs`, `apps/api/src/core/client_ip.rs` |
| Background sweeps, startup       | `apps/api/src/main.rs`                                                                            |
| Operator refresh tool            | `apps/api/examples/refresh_provider_credentials.rs`                                               |
| Schema                           | `apps/api/migrations/`                                                                            |

At startup the API connects to Postgres with at most 10 connections, runs the migrations, then recomputes `account_label` and `plan` of every connected row from its stored credential (`refresh_stored_connection_metadata`).

## Access classes

| Class         | Routes                                                                                                                                                                                  | Credential                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Public        | `GET /health`, `/docs`, `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/session`, `POST /tts`, `/reel/*`, `GET /agent-pools`           | none (`GET /agent-pools` reads the session when one is present; refresh and logout read their cookies) |
| Session       | `/agent-connections*`, `/agent-pools/*` writes, `/agent-pool-requests/*`, `/gateway-keys*`, `/organizations*`, `/organization-summaries`, `/organization-invitations*`, `/playground/*` | `hub_session` cookie                                                                                   |
| Hub key       | `/gateway/*` provider routes                                                                                                                                                            | `Authorization: Bearer hw_live_…` or `x-goog-api-key`                                                  |
| Service token | `/internal/telegram/*`                                                                                                                                                                  | `x-hub-william-telegram-token` (see [telegram](./telegram.md))                                         |

Browser CORS allows credentials; origins come from `FRONTEND_ORIGIN`, plus localhost development origins only when `COOKIE_SECURE` is false (`apps/api/src/core/cors.rs`).

## Hub sessions

A login creates one `sessions` row holding the SHA-256 hex of two random 32-byte tokens and their expiries. The raw tokens exist only in cookies.

| Cookie        | Lifetime | Purpose                           |
| ------------- | -------- | --------------------------------- |
| `hub_session` | 5 hours  | Access token; checked per request |
| `hub_refresh` | 7 days   | Rotates the session               |

Both cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` follows `COOKIE_SECURE`.

- `POST /auth/register` (201) and `POST /auth/login` (200) set both cookies. Usernames are trimmed and lowercased, 3–32 characters from `[a-z0-9_-]`. Passwords are 8–128 bytes and hashed with Argon2 (crate defaults). `recovery_email` is optional, lowercased and validated; it is stored and returned, and no route uses it for recovery.
- `POST /auth/refresh` locks the row matching `hub_refresh` (`FOR UPDATE`), requires an unexpired refresh window, and overwrites both token hashes and both expiries. The previous tokens stop matching any row. The refresh window slides: each refresh grants 7 more days, with no absolute cap.
- `GET /auth/session` answers 200 with the user; 204 when the browser holds neither cookie; 401 when only `hub_refresh` is present or the access token is expired. Both cookies are `HttpOnly`, so only the server can tell a visitor who never signed in (204, do not refresh) from one whose access token lapsed (401, refresh can succeed).
- `POST /auth/logout` (204) deletes the row by either token hash and clears both cookies. It is the only code path that deletes session rows; rows past their refresh expiry stay in the table.
- Handlers resolve the caller with `authenticated_user_id` (401 when absent) or `optional_authenticated_user_id` (public routes).

## Rate limits

Limits are in-memory token buckets, one set per route group (`apps/api/src/core/rate_limit.rs`). A bucket starts full with N tokens and refills at N per minute, so "10/min" permits 10 requests at once, then one every six seconds. Counts are per process; with several replicas the effective limit is multiplied. A refused request gets 429 with a `Retry-After` header (seconds, at least 1). Session `GET` routes (connections, keys, organizations) are not limited; `GET /agent-pools` is, because it is public and does provider work. `GET /gateway/*/models` spends from the Hub-key budget, and `GET /reel/stream` and `GET /reel/download` from the per-IP reel budget.

Buckets are keyed by:

- **IP** — login and register.
- **User** — session routes. A request without a valid session is counted against its IP instead and left for the handler to reject. `/auth/refresh` is keyed this way, so a refresh after the access token expires is counted by IP.
- **Hub key** — `/gateway/*`; a bucket exists only for keys that have authenticated. Failed key attempts spend from a separate per-IP budget that is checked before the handler runs.

Client IP is the socket peer address. When `TRUST_PROXY_HEADERS` is true it is the value of the header named by `CLIENT_IP_HEADER` (default `x-real-ip`) with no fallback to the peer; a missing or malformed header shares one `Unknown` bucket. IPv4-mapped IPv6 addresses count as IPv4, and IPv6 addresses are grouped by /64.

| Budget                 | Per minute | Routes                                                                                               |
| ---------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `AuthRegister`         | 10         | `POST /auth/register`                                                                                |
| `AuthLogin`            | 10         | `POST /auth/login`                                                                                   |
| `AuthRefresh`          | 10         | `POST /auth/refresh`                                                                                 |
| `AgentOAuth`           | 10         | `POST /agent-connections/start` and `POST /agent-connections/{id}/complete` (shared)                 |
| `AgentKeyConnect`      | 10         | `POST /agent-connections/deepseek` and `/groq` (shared)                                              |
| `AgentRefresh`         | 10         | `POST /agent-connections/{id}/refresh`                                                               |
| `AgentResetCredits`    | 10         | `POST /agent-connections/{id}/reset-credits`                                                         |
| `PoolRequest`          | 10         | `POST /agent-pools/{id}/requests`                                                                    |
| `PoolInvite`           | 10         | `POST /agent-pools/{id}/members`                                                                     |
| `PoolDecision`         | 30         | `DELETE /agent-pools/{id}/members/{username}` and `POST /agent-pool-requests/{id}/decision` (shared) |
| `GatewayKeyManagement` | 10         | `POST /gateway-keys` and `DELETE /gateway-keys/{id}` (shared)                                        |
| `AgentPools`           | 30         | `GET /agent-pools`, per user when signed in and per IP otherwise                                     |
| `GatewayKey`           | 30         | each Hub key on `/gateway/*`                                                                         |
| `GatewayFailedAuth`    | 30         | failed Hub-key attempts per IP                                                                       |

Budgets for other features (organization writes, Playground, TTS, reel) are defined next to these in `Limit::per_minute`.

## Provider connections

A user can hold any number of connections, including several of the same provider. Providers are `chatgpt`, `claude`, `gemini`, `grok`, `deepseek` and `groq`. A row has a `status` (`pending`, `connected`, `failed`; `disconnected` is in the status enum but no code path writes it) and, independently, an `availability_status` (next section).

### Connect flows

| Provider       | Flow                                                                                      | User action                                                                                | After the exchange                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| ChatGPT        | Authorization code with PKCE (S256); fixed redirect `http://localhost:1455/auth/callback` | Opens the authorization URL, signs in, pastes the redirect URL into `POST …/{id}/complete` | Token exchange at `CODEX_AUTH_ISSUER` (default `https://auth.openai.com`)                                          |
| Claude         | Authorization code with PKCE; redirect `CLAUDE_REDIRECT_URL`                              | Pastes the callback URL, or `code#state`                                                   | Plan comes from the profile API (`CLAUDE_PROFILE_URL`)                                                             |
| Gemini (AGY)   | Google authorization code with PKCE, `access_type=offline`, `prompt=consent`              | Pastes the callback URL                                                                    | `userinfo` gives the email; Code Assist `loadCodeAssist` must return `cloudaicompanionProject`; plan from the tier |
| Grok           | OAuth device code (`urn:ietf:params:oauth:grant-type:device_code`) at `GROK_AUTH_ISSUER`  | Opens the verification URL and enters the user code; `complete` is rejected                | The browser polls `GET /agent-connections/{id}`, which polls the token endpoint                                    |
| DeepSeek, Groq | API key sent to `POST /agent-connections/deepseek` or `/groq`                             | Enters a 20–512 character key from `[A-Za-z0-9_-]`                                         | Validated by `GET {base}/models` (401/403 gives 422); plan is `API`; no refresh token                              |

Mechanics of the browser flows:

1. `POST /agent-connections/start` inserts a `pending` row and an `agent_connection_authorizations` row holding the encrypted PKCE verifier and `state` (or device code), and returns the prompt. A prompt lasts 15 minutes; a Grok prompt lasts the provider's `expires_in` (900 seconds by default). The Grok verification URL must have the expected origin: `https://accounts.x.ai` when the issuer is `auth.x.ai`, otherwise the issuer's own origin.
2. `complete` accepts a full callback URL (`code` and `state` query parameters) or `code#state`. When a `state` is present it must equal the stored one; a bare code carries none and is accepted.
3. Every tick of the sweep (below), `expire_abandoned_authorizations` deletes expired prompts. A non-connected row becomes `failed` with "Authorization expired. Start again."; a connected row stays connected, and one that was `reauth_required` gets that message.
4. `finish_connection` stores the credential and marks the row `connected` with availability `active`.

### Identity and merge

A provider account is represented by at most one connected row. `provider_account_identity` derives a stable string and the connection fails with 422 when the provider returns none:

| Provider            | Identity, first match wins                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT             | `chatgpt:sub:<JWT sub>`, else `chatgpt:email:<email>`                                                                                  |
| All other providers | The stored `hub_account_identity`; `id:<provider account id or JWT sub>`; `key:<SHA-256 of the key>` (DeepSeek, Groq); `email:<email>` |

Under a Postgres advisory lock keyed on the SHA-256 of the identity, `finish_connection` decrypts every other connected row of the same provider and compares identities. On a match the credential is written onto the matched row, `user_id` moves to the connecting user (a trigger deletes that connection's organization shares when the owner changes), the connecting user's join requests on it are deleted, and the new pending row is deleted. A reconnect of a row that already has a credential must present the same identity, otherwise 422 "Reconnect with the same provider account that owns this pool."

### Stored credential and labels

- The credential is one JSON blob encrypted with AES-256-GCM, a random 12-byte nonce per write, and the key `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` (base64url, 32 bytes). Pending authorization secrets use the same scheme. The ciphertext lives in `agent_connection_credentials`; connection responses are built from `ConnectionRow`, which has no credential columns.
- `account_label` stores only a mask. For an email it keeps the first two and last three characters of the local part (up to any `+`), and the first three characters of the domain and the final suffix: `john.doe@example.com` becomes `jo**doe@exa**.com`. API keys show `••••` plus the last four characters. An unparseable address shows `connected account`.

### Owner actions

All of these return 404 for a connection the caller does not own.

| Route                                        | Behavior                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /agent-connections`                     | The caller's connections, oldest first                                                                                                                                                                                                            |
| `GET /agent-connections/{id}`                | Pending: polls the provider (Grok) or returns the stored prompt. Connected: runs a near-expiry refresh and returns the latest state                                                                                                               |
| `POST /agent-connections/{id}/refresh`       | Forced refresh of a connected row. When the provider shows the login is dead it starts a new authorization on the same row (availability `reauth_required`, `failure_message` NULL)                                                               |
| `POST /agent-connections/{id}/reset-credits` | ChatGPT only: redeems one banked reset credit; a retry reuses the credit's request id so the provider returns the original outcome                                                                                                                |
| `DELETE /agent-connections/{id}`             | Deletes the row and what references it (credentials, prompts, join requests, organization shares). Organization usage events are kept, with `connection_id` set to NULL. Takes the credential row lock first so it waits for an in-flight refresh |

## Availability

`availability_status` says whether the gateway may use the connection. Candidate ordering and failover are in [gateway](./gateway.md); this section covers the states.

| State             | Meaning                                                  | Entered by                                                                                                                                                                | Left by                                                                            |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `active`          | Serves traffic                                           | Connect; a successful probe request; a successful forced or recovery refresh                                                                                              | A provider 429, or a rejected credential                                           |
| `rate_limited`    | Cooling down until `rate_limited_until`                  | A provider 429 sets `now + 30 minutes` (never applied over `reauth_required`)                                                                                             | The first request after `rate_limited_until` claims it and moves it to `half_open` |
| `half_open`       | One probe request in flight                              | Claim sets `retry_claimed_at = now`; a claim older than 5 minutes can be taken again; a probe that ends without a verdict clears `retry_claimed_at` and stays `half_open` | Probe success returns to `active`; another 429 returns to `rate_limited`           |
| `reauth_required` | The owner (or the recovery sweep) must restore the login | A rejected credential, a dead refresh token, an AGY verification challenge, or an owner Refresh that finds the login dead                                                 | A successful forced or recovery refresh; a completed reconnect                     |

The API keeps reporting `rate_limited` with its `retry_at` after the time has passed, until a request claims the connection. A forced refresh (owner Refresh) restores `active` from any state.

`failure_message` records why a connection is `reauth_required`:

| Message (constant)                                                                                           | Meaning                                          | Retried by the recovery sweep |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------- |
| "Provider login is required. Reconnect this pool." (`PROVIDER_LOGIN_REQUIRED_MESSAGE`)                       | The gateway got a 401 that a refresh did not fix | Yes                           |
| "Authorization expired. Start again." (`EXPIRED_AUTHORIZATION_PROMPT_MESSAGE`)                               | An owner's reconnect prompt expired unfinished   | Yes                           |
| "Provider account verification is required. Reconnect this pool." (`ACCOUNT_VERIFICATION_REQUIRED_MESSAGE`)  | Google's account-verification challenge          | Yes                           |
| "Provider authorization expired. Refresh this pool to reconnect." (`EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE`) | The refresh credential is dead                   | No; waits for the owner       |
| NULL                                                                                                         | The owner's reconnect prompt is pending          | Skipped while a prompt exists |

## Credential refresh

OAuth credentials rotate in the background so a connection keeps working without its owner. Each connection has a `next_refresh_at` in `agent_connection_credentials`, so accounts keep the spread of the times they were connected.

### Modes

Every refresh runs through `refresh_connected_connection` under a row lock on the credential, in a detached task. Why: a provider may rotate the refresh token the moment it answers, and a caller dropped before the commit would roll the new token back, leaving a credential that can never be refreshed.

| Mode         | Trigger                                                                                                    | Refreshes when                                           | Restores availability        |
| ------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| `NearExpiry` | Any request that needs the credential (`gateway_credential`, `GET /agent-connections/{id}`, usage lookups) | The access token expires within 5 minutes                | No                           |
| `Rejected`   | A provider rejected an access token (`recover_rejected_credential`)                                        | The stored token's SHA-256 still equals the rejected one | No                           |
| `Force`      | Owner Refresh, operator tool                                                                               | Always                                                   | Yes                          |
| `Stale`      | 60-second sweep                                                                                            | `next_refresh_at <= now`                                 | No                           |
| `Recover`    | 60-second sweep, on recoverable `reauth_required` rows                                                     | `next_refresh_at <= now`                                 | Yes, recoverable states only |
| `Nightly`    | Once per Vietnam day                                                                                       | Last refresh activity is before that day's midnight      | No                           |

Why `Rejected` compares fingerprints: when another request already rotated the token, the caller re-reads the stored credential instead of refreshing a second time.

Requests read the credential without a row lock, so many members sharing one account do not queue behind each other or behind a background refresh; only a credential about to expire takes the lock.

### Schedule

`main.rs` runs one loop that ticks every 60 seconds (the first tick is immediate) and does three things in order:

1. **Nightly sweep**, when the Vietnam calendar day (UTC+7) differs from the last day it completed (kept in memory; if the account selection query fails the sweep is retried on the next tick, while a failure on one account is counted and the day is still marked done).
2. **`expire_abandoned_authorizations`.**
3. **`refresh_due_provider_credentials`**, oldest `next_refresh_at` first and one account at a time. It selects connected rows with `next_refresh_at <= now` that are either OAuth providers not in `reauth_required` (`Stale`) or `reauth_required` rows with a recoverable `failure_message` and no pending prompt (`Recover`). DeepSeek and Groq keys are never `Stale`.

A scheduled attempt first sets `refresh_attempted_at = now` and `next_refresh_at = now + 30 minutes`, so an aborted attempt cannot make the next tick pick the account up again. A successful refresh sets `next_refresh_at` to 30 minutes ahead, or to 5 minutes before the refresh token expires when the provider reports an expiry earlier than that (never less than 60 seconds out; an expiry already past is ignored).

The rotated credential is written before the metadata lookup and the verification probe, because a rotation that is lost can never be replayed at the provider.

### Outcomes

| Provider answer                                                                               | Scheduled modes (`Stale`, `Nightly`, `Recover`)                                                                   | `Force`, `NearExpiry`, `Rejected`         |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 400/401 with `invalid_grant`, ChatGPT `refresh_token_invalidated`, or no refresh token stored | Mark `reauth_required` with the terminal message                                                                  | Same                                      |
| Network error, timeout, 408, 429, 5xx, or an unparseable success body                         | Retry once after 3 seconds under the same lock (2 attempts); then wait for the regular `next_refresh_at`; no mark | Returned to the caller; no mark, no retry |
| Any other 4xx                                                                                 | No retry, no mark; waits for the regular schedule                                                                 | Returned to the caller                    |

A `Recover` attempt that finds the refresh token dead rewrites a recoverable message to the terminal one, which stops further retries. DeepSeek and Groq have no refresh token: their "refresh" validates the key with `GET {base}/models`, a 401/403 marks `reauth_required`, and other failures are returned without marking.

### Request-time recovery

When a provider rejects an access token on a gateway request, the gateway calls `recover_rejected_credential`: one `Rejected` refresh, then one retry of the request on the same account. The account is marked `reauth_required` (`mark_reauthorization_required_if_current`) only when the refresh token is rejected or the provider rejects the fresh token too. The mark is a compare-and-set against the observed access token, so a refresh or reconnect that replaced it under the lock wins over an older rejection.

### Nightly check

`refresh_nightly_provider_credentials` selects connected rows that are not `reauth_required` and whose last refresh activity (the later of `updated_at` and `refresh_attempted_at`) predates the Vietnam day start. OAuth accounts rotate; DeepSeek and Groq keys, which are never in the `Stale` set, are validated. The row lock re-check keeps the sweep idempotent across replicas and restarts.

### Shutdown and operator tool

On shutdown the API stops starting new scheduled refreshes (`stop_credential_sweeps`) and drains requests. It then waits up to 25 seconds for the sweep task to stop and up to another 25 seconds for refreshes already talking to a provider (`wait_for_credential_refreshes`). `cargo run --example refresh_provider_credentials -- --all` runs a `Force` refresh over every connected row without starting any interactive authorization.

## AGY verification

Google answers some Gemini (AGY) requests with an account-verification challenge: a 403 whose body contains "verify your account to continue". The link that lets the owner clear it is a `validationUrl` that Google puts in the `loadCodeAssist` tier payload, or occasionally in the refusal body. The connection keeps the link in `validation_url` so the owner can open it. The rationale and the recovery design are in [ADR-0003](../decisions/0003-recoverable-agy-account-verification.md); the mechanics are:

- **Marks.** A forwarded Gemini generation or `countTokens` request that receives that 403 (first 64 KiB of the body inspected) marks the connection `reauth_required` with `ACCOUNT_VERIFICATION_REQUIRED_MESSAGE`, only while the observed access token is still the stored one. The stored URL must be `https` on `google.com` or `*.google.com`. Any other 403 rotates to the next candidate without a mark.
- **Probe.** `Force` and `Recover` refreshes of a Gemini connection run `probe_gemini_account_verification` after the rotation: model listing, then `countTokens`, then a minimal generation. A challenge on listing or counting does not condemn the login. The result is `Verified` (generation succeeded, or it failed with an HTTP status other than the challenge after a successful count), `ReauthorizationRequired` (generation returned the challenge) or `Inconclusive`.
- **Clears.** Only a `Verified` probe restores availability; `Recover` restores only recoverable messages. An inconclusive probe leaves a `reauth_required` connection as it is, and an owner Refresh that ends `reauth_required` starts a new Google login. A refresh that does not end in a challenge clears `validation_url`; a completed reconnect clears it too.

## Pools and membership

`GET /agent-pools` returns every `connected` connection, to anyone, with `account_label` (masked), `plan`, `agent` (provider label), `availability` (`status`, `retry_at`, `validation_url`), `capacity`, `owner` and `members`. Members are the owner first, then accepted users ordered by acceptance time. `avatar_label` is the first three characters of the username with the first one upper-cased. `requests` shows every join request to the owner, only the viewer's own to another signed-in user, and nothing to an anonymous caller. `AgentPoolShareEvidence` (`share`, `usage_available_percent`) is a fixed default (100% available, zero tokens); no per-member accounting happens in this response.

Pools have no member limit. `capacity` is a column (default 6, check 2–100) that is serialized but never compared with the member count.

| Route                                         | Who        | Behavior                                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /agent-pools/{id}/requests`             | Any user   | Body `telegram` (2–80 bytes) and `reason` (10–500 bytes), trimmed; multi-byte text such as Vietnamese gets fewer characters. The owner cannot request. One request per user per pool in any status, so a rejected user cannot re-request (422) |
| `POST /agent-pool-requests/{id}/decision`     | Pool owner | Body `status` `accepted` or `rejected` (`pending` is rejected with 422); a decision can be changed later in either direction                                                                                                                   |
| `POST /agent-pools/{id}/members`              | Pool owner | Body `username`. Upserts the user's row as `accepted` with `reason` "Invited by pool owner."; 404 unknown user, 422 for the owner or an accepted member                                                                                        |
| `DELETE /agent-pools/{id}/members/{username}` | Pool owner | Deletes the accepted row (404 if none); the user may request again                                                                                                                                                                             |

An accepted row grants gateway access to the pool: the account joins the member's candidate set and counts toward Hub-key creation. Access is evaluated per request, so a decision or removal takes effect on the next call.

## Hub keys

- `POST /gateway-keys` returns the key once (201). It is `hw_live_` plus 32 random bytes in base64url. The database stores only the SHA-256 digest (`key_hash`, unique) and `last_four`, the last four characters of the key. Creation returns 404 unless the user owns a connected connection or has an accepted membership in one.
- `GET /gateway-keys` lists the caller's non-revoked keys, newest first, with `created_at` and `last_used_at`. `DELETE /gateway-keys/{id}` sets `revoked_at` (404 for another user's key). Keys never expire.
- A key is accepted as `Authorization: Bearer …` or `x-goog-api-key` (`gateway_key_from_headers`); the value must start with `hw_live_` and be longer than 24 characters. Each successful authorization updates `last_used_at`.
- `gateway_keys.organization_id` is read at authorization and switches candidates to organization shares, but `create_key` never sets it, so every key is personal. Organization behavior is in [organizations](./organizations.md).

## Provider usage

`GET /agent-pools` fetches live usage for every pool, concurrently, through `usage::for_connection` with a 4-second timeout. It obtains the credential with `provider_credential`, so a public listing can trigger a near-expiry refresh. The route spends from the `AgentPools` budget, per user when a session is present and per IP otherwise. A failure or timeout yields a single `unavailable` metric with an explanation instead of an error.

| Provider | `usage_metrics` | What the API returns                                              |
| -------- | --------------- | ----------------------------------------------------------------- |
| ChatGPT  | true            | Usage windows from `wham/usage` and banked reset credits          |
| Claude   | true            | Usage windows from the Anthropic OAuth usage endpoint             |
| Grok     | false           | Usage metrics (still fetched; the UI hides them)                  |
| Gemini   | false           | One `unavailable` metric: Google exposes no stable quota endpoint |
| DeepSeek | false           | One `unavailable` metric                                          |
| Groq     | false           | One `unavailable` metric                                          |

Window values read "N% remaining" with N rounded to an integer, so under 0.5% remaining reads as 0%. The `usage_metrics` flag comes from the provider catalogue (see [gateway](./gateway.md)); the organization agents endpoint fetches usage only for providers where it is true, and the frontend shows usage only for those providers.

## Tables

| Table                             | Holds                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                           | Username (unique, lowercase), Argon2 hash, optional recovery email                                                                              |
| `sessions`                        | Per login: access and refresh token hashes and expiries                                                                                         |
| `agent_connections`               | One row per provider account: provider, status, masked label, plan, availability fields, `failure_message`, `validation_url`, `capacity`, owner |
| `agent_connection_credentials`    | Ciphertext and nonce, token expiries, `refresh_attempted_at`, `next_refresh_at`                                                                 |
| `agent_connection_authorizations` | One pending prompt per connection: flow, encrypted secret, `expires_at`                                                                         |
| `agent_pool_join_requests`        | Requests and memberships, unique per (connection, user), status `pending`/`accepted`/`rejected`                                                 |
| `gateway_keys`                    | Hub key digests, `last_four`, `last_used_at`, `revoked_at`, optional `organization_id`                                                          |

Organization tables are in [organizations](./organizations.md) and `telegram_*` tables in [telegram](./telegram.md).
