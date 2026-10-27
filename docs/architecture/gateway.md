# Gateway

The gateway is the part of the Rust API that forwards requests to provider
subscriptions on behalf of connected accounts. Coding agents reach it with a Hub
key; the Playground reaches it through a signed-in browser session. Both use one
selection and failover engine, so account choice, cooldowns, retries and usage
recording behave the same on every route. Credential storage, refresh and the
availability state machine are in [accounts-and-pools.md](./accounts-and-pools.md).

## Where it runs

- Code: `apps/api/src/api/gateway/` (`mod.rs`, `routes.rs`, `voice.rs`,
  `groq_voice.rs`, `groq_voice_stream.rs`). `apps/api/src/api/router.rs` merges
  `gateway::routes` into the same Axum router as every other API route, and the
  nginx edge proxies `/api/gateway/*` to it ([deployment.md](./deployment.md)).
- The Playground calls the gateway as Rust functions inside the API process
  (`response_for_user`, `response_for_organization_user`, `models_for_user`,
  `models_for_organization_user`). No HTTP hop separates API and gateway.
- Why: a prompt must not pay an extra network hop. Extracting the gateway into
  its own service needs an explicit internal contract that keeps this property.
- Every request carries a `GatewaySelection`: the user, an optional preferred
  `connection_id` and an optional `organization_id`.

| Caller        | Authentication | Preferred account               | Scope                                 |
| ------------- | -------------- | ------------------------------- | ------------------------------------- |
| Coding client | Hub key        | none                            | personal                              |
| Playground    | session cookie | the chosen account, tried first | personal, or one organization's pools |

## Routes

All routes are registered in `provider_routes` (`apps/api/src/api/gateway/routes.rs`)
behind the Hub-key limiter, with the request-body limit disabled.

| Provider | Method | Path                                                          |
| -------- | ------ | ------------------------------------------------------------- |
| ChatGPT  | POST   | `/gateway/openai/v1/responses`                                |
| ChatGPT  | GET    | `/gateway/openai/v1/models`                                   |
| Claude   | POST   | `/gateway/claude/v1/messages`                                 |
| Claude   | POST   | `/gateway/claude/v1/messages/count_tokens`                    |
| Claude   | GET    | `/gateway/claude/v1/models`                                   |
| Grok     | POST   | `/gateway/grok/v1/chat/completions`                           |
| Grok     | POST   | `/gateway/grok/v1/responses`                                  |
| Grok     | GET    | `/gateway/grok/v1/models`                                     |
| Gemini   | GET    | `/gateway/gemini/v1beta/models`                               |
| Gemini   | POST   | `/gateway/gemini/v1beta/models/{model}:generateContent`       |
| Gemini   | POST   | `/gateway/gemini/v1beta/models/{model}:streamGenerateContent` |
| Gemini   | POST   | `/gateway/gemini/v1beta/models/{model}:countTokens`           |
| DeepSeek | POST   | `/gateway/deepseek/chat/completions`                          |
| DeepSeek | POST   | `/gateway/deepseek/responses`                                 |
| DeepSeek | GET    | `/gateway/deepseek/models` (no `/v1` segment)                 |
| Groq     | POST   | `/gateway/groq/v1/chat/completions`                           |
| Groq     | POST   | `/gateway/groq/v1/responses`                                  |
| Groq     | GET    | `/gateway/groq/v1/models`                                     |

Hub key management uses the session cookie and is the only gateway surface in
`apps/api/openapi.json`: `GET /gateway-keys`, `POST /gateway-keys`,
`DELETE /gateway-keys/{key_id}`.

## Hub keys and limits

- A key is `hw_live_` plus 32 random bytes in base64url. The database stores its
  SHA-256 hash, `last_four`, `created_at`, `last_used_at` (touched on every
  successful authorization) and a soft `revoked_at`. A key has no expiry and is
  shown once, at creation.
- A key is read from `Authorization: Bearer <key>` or `x-goog-api-key: <key>` on
  every provider route. A value that does not start with `hw_live_` or is not
  longer than 24 characters is rejected before any lookup.
- Creating a key needs at least one connected account the user owns or an
  accepted pool membership; otherwise `404`. Creating and revoking share a limit
  of 10 per minute per user.
- Every key is personal. `gateway_keys.organization_id` exists and authorization
  honors it by switching candidates to the organization's shares, but no endpoint
  sets it.
- Limits are in-memory token buckets per API process
  (`apps/api/src/api/limits.rs`): 30 requests per minute per key, and 30 failed
  authentications per minute per client address. An address with an exhausted
  failure budget is refused before any key lookup.

| Code                     | HTTP                    | When                                                                                                 |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `invalid_gateway_key`    | 401                     | missing, malformed, unknown or revoked key                                                           |
| `forbidden`              | 403                     | no connected account of that provider in scope; a browser request named an account outside its scope |
| `all_pools_rate_limited` | 429                     | every candidate is cooling down or already being probed                                              |
| `provider_unavailable`   | 502                     | network failure, an unrecoverable rejected login, or every account needs reconnect                   |
| `rate_limited`           | 429, with `Retry-After` | a per-key or per-address limit is exceeded                                                           |

An upstream error response that the gateway does not act on (for example `400`)
is returned unchanged.

## Account selection

`connected_provider_candidates` lists the connected accounts of the requested
provider that the caller may use:

- **Personal scope:** accounts the user owns, plus accounts whose pool accepted the
  user.
- **Organization scope:** accounts shared into the organization where both the
  caller and the sharer are accepted members. Scopes never mix.

An empty list is `forbidden`. The list is ordered by availability bucket first:

| Bucket | Accounts                                                  |
| ------ | --------------------------------------------------------- |
| 0      | `half_open` with no probe in flight                       |
| 1      | `rate_limited` whose cooldown has passed                  |
| 2      | `active`                                                  |
| 3      | everything else (cooling down, `reauth_required`, probed) |

Inside a bucket, personal scope puts the user's own accounts first, then the most
recently updated; organization scope orders by share creation, newest first.

A browser request that names a `connection_id` must find it in the list (else
`forbidden`); that account moves to the front and the rest stay available for
failover. A relayed response to such a request carries `x-hub-connection-id`
(exposed through CORS), set to the account that answered, which is the named
account when no failover happened. A kept `402`/`403` or a transient response
returned after the budget ran out omits it, and key clients never get it. The web
app shows the header only when it differs from the selection.

Before sending, `claim_candidate` decides whether an account is usable:

- `active` is usable.
- `rate_limited` past `rate_limited_until` becomes `half_open` atomically, and the
  claiming request is the probe.
- `half_open` is claimable when unclaimed or when its claim is older than five
  minutes.
- A cooling-down account, a `reauth_required` account or a `half_open` account
  claimed elsewhere is skipped and counted as rate-limited or needing reconnect.

A probe that ends without success or `429` is released (`release_probe`).

## Failover and retry

The loop in `proxy_request_for_user` walks the ordered candidates. For each one it
loads the credential (`gateway_credential`; the stored provider must match the
route) and sends the request with the provider's headers.

| Upstream result                                                               | Action                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `429`                                                                         | Mark the account `rate_limited` for 30 minutes and try the next account.                        |
| `401`; Grok `403`                                                             | Refresh the credential once and retry the same account; see below.                              |
| `402` or `403` (Gemini: `403` only; Grok `403` is a login failure)            | Keep the response, try the next account.                                                        |
| `408`, `500`, `502`, `503`, `504`, or a network error before response headers | Retry with backoff; see below.                                                                  |
| Anything else                                                                 | Return it to the client. The account is marked `active`, which clears `half_open` and cooldown. |

**Rejected login.** `handle_rejected_credential` refreshes the credential once
(or picks up a token another request already rotated) and retries the same
account. That send does not spend the attempt budget. If the provider rejects the
fresh token too, or the refresh token itself is rejected, the account is marked
`reauth_required`, compared against the token that failed so a newer credential
is never overwritten. A transient refresh failure moves to the next account
without marking.

**Attempt budget.** A request makes at most `max(4, number of candidates)`
upstream sends, so a large pool can reach every account.

**Retrying one account.** An account gets at most two sends. The last remaining
candidate may use the rest of the budget. An earlier candidate retries only while
the budget leaves at least one send for each candidate still to try.

**Backoff.** The delay before the retry that follows upstream send _n_ of the
request (counted across all accounts) is 500 ms · 2^(n−1), capped at 2 s, with
±20% jitter and never above 2 s. An integer `Retry-After` header is honored up to
the same 2 s cap; the larger of the two applies.

**Final outcome.** When the budget ends on a transient upstream status, that
response is returned unchanged. When the candidates run out instead, the first
rule that applies wins:

1. `all_pools_rate_limited` (`429`) if any account was cooling down or rate
   limited.
2. A `provider_unavailable` error saying every account needs to reconnect, if any
   account was `reauth_required`.
3. The last kept `402`/`403` response, unchanged.
4. The last error (a network or credential failure), or `forbidden`.

**Never after the response starts.** Retry and failover happen only before the
gateway returns a response. Once a candidate answers with anything that is not
acted on, its stream is relayed and never replayed on another account.

## Streaming and sizing

- Request headers are forwarded except `authorization`, `cookie`, `host`,
  `content-length`, `x-api-key`, `x-goog-api-key` and hop-by-hop headers. The
  gateway adds the account's bearer token. The query string is kept. Response
  headers are forwarded except hop-by-hop headers and `set-cookie`. The Gemini
  path forwards no client headers: it sends a bearer token, the Antigravity
  `user-agent` and a JSON content type with its own wrapped body.
- Response bodies are streamed from upstream without buffering.
- The gateway routes have no request-body limit (`DefaultBodyLimit::disable`), and
  nginx sets `client_max_body_size 0` for `/api/gateway/`. The gateway HTTP client
  (`gateway_http_client`) has a 10 s connect timeout and no total timeout; nginx's
  `proxy_read_timeout 300s` is an idle check between bytes.
- The gateway applies no token, context or size policy. Compatibility
  transforms (below) make a request acceptable; they never add a ceiling.
- Why: real agent sessions exceed default body limits, and a total timeout cut a
  streaming turn before its terminal event. Browser routes stay bounded:
  Playground chat 32 MiB (also in nginx), voice session 96 KiB.
- The gateway relays upstream bytes unchanged (Gemini aside) and never fabricates
  `finish_reason` or `[DONE]`. DeepSeek's Responses route streams explicit
  completed, incomplete and failed events, and OMP is configured to use it
  (`api: openai-responses` in the catalogue).

## Upstream details by provider

The ChatGPT, Claude and Grok message URLs, the ChatGPT models URL, the Claude
count-tokens URL, the Grok models URL, the Codex voice URL and the Antigravity
`user-agent` string are constants. The Code Assist, DeepSeek, Groq, Claude and
ChatGPT discovery URLs and the Codex, Claude and Grok client versions come from
`apps/api/src/core/config.rs`, each with an environment override.

| Provider | Upstream                                                          | Environment              |
| -------- | ----------------------------------------------------------------- | ------------------------ |
| ChatGPT  | `chatgpt.com/backend-api/codex/responses`                         | `CODEX_CLIENT_VERSION`   |
| Claude   | `api.anthropic.com/v1/messages` (and `/count_tokens`)             | `CLAUDE_CLIENT_VERSION`  |
| Grok     | `cli-chat-proxy.grok.com/v1/{chat/completions,responses}`         | `GROK_CLIENT_VERSION`    |
| Gemini   | Code Assist `v1internal:*` at `daily-cloudcode-pa.googleapis.com` | `GEMINI_CODE_ASSIST_URL` |
| DeepSeek | `api.deepseek.com/{chat/completions,responses}`                   | `DEEPSEEK_API_URL`       |
| Groq     | `api.groq.com/openai/v1/{chat/completions,responses}`             | `GROQ_API_URL`           |

**ChatGPT (Codex).** `strip_unsupported_codex_fields` drops top-level
`max_output_tokens`, which the subscription endpoint rejects. Headers:
`originator: codex_cli_rs`, `user-agent: codex_cli_rs/<version>` and
`chatgpt-account-id`, taken from the stored token's `account_id` or the ID-token
claim.

**Claude.** `ensure_claude_billing_header` adds the line
`x-anthropic-billing-header: cc_version=<version>.bd6; cc_entrypoint=sdk-cli;` to
the request unless `system` already contains one: it prefixes a string `system`,
becomes the first text block of an array `system`, or creates the array when
`system` is absent. Headers: `anthropic-version` (the client's, else `2023-06-01`), `anthropic-beta`
merged with `claude-code-20250219` and `oauth-2025-04-20`,
`user-agent: claude-cli/<version> (external, sdk-cli)`, `x-app: cli` and
`anthropic-dangerous-direct-browser-access: true`. `count_tokens` is proxied the
same way.

**Grok.** Grok Build headers (`grok_proxy_headers`): `x-xai-token-auth`,
`x-authenticateresponse`, `x-grok-client-identifier: hub-william`,
`x-grok-client-mode: headless`, `x-grok-client-version`, and a Hub `user-agent`.
Non-`GET` requests add `x-grok-conv-id` and `x-grok-session-id` (one fresh UUID for
both), `x-grok-req-id` (another fresh UUID) and `x-grok-model-override` (the body's `model`, else `grok-build`).
A Grok `403` is treated as a rejected login, not an account-level refusal.

**DeepSeek and Groq.** Plain bearer-token requests to the provider API. Their
accounts are API keys with no refresh token, so the rejected-login path
revalidates the key with the provider and marks the account `reauth_required`
when the provider refuses it ([accounts-and-pools.md](./accounts-and-pools.md)).

**Gemini (AGY, Google Code Assist).** The client speaks the Gemini API shape and
the gateway translates to Code Assist `v1internal`:

- Generation and streaming wrap the client body as `{model, project, requestId,
request, userAgent: "antigravity", requestType: "agent"}` and post it to
  `:generateContent` or `:streamGenerateContent?alt=sse`. `countTokens` sends
  `{request: {model: "models/<id>", contents}}`. The model segment must be
  non-empty with no `/`; other operations are `404`.
- The credential must hold `access_token` and `cloudaicompanion_project`. The
  project is re-resolved on every request with `loadCodeAssist` (metadata
  `ideType: ANTIGRAVITY`) and falls back to the stored one.
- Requests carry the Antigravity CLI `user-agent` (`ANTIGRAVITY_CLIENT_VERSION`).
- Model ids map to effort variants in `antigravity_model_id`. For the flash
  families (`gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.7-flash`,
  `gemini-3.6-flash`), `generationConfig.thinkingConfig.thinkingBudget` of `-1`
  selects `-high`, a budget of 1000 or less selects `-low`, and anything else
  (including no budget) selects `-medium`. `gemini-3.1-pro` and
  `gemini-3.1-pro-preview` select `-high` for budget `-1` and `-low` otherwise;
  `gemini-3.1-pro-preview-customtools` is always `gemini-3.1-pro-high`. Ids that
  already carry a variant, and the non-Gemini ids Code Assist serves
  (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`), pass
  through unchanged.
- Responses are unwrapped: the `response` object is returned and `traceId`
  becomes `responseId`. SSE `data:` lines are unwrapped one by one and line endings
  are normalized to `\n`. Error responses are forwarded as received. A browser
  stream cancels the upstream request when the client disconnects.
- A `403` rotates to the next account. On generation and `countTokens` the gateway
  first reads up to 64 KiB of the body: a message containing "verify your account
  to continue" marks the account `reauth_required`, with the Google-hosted HTTPS
  validation link when the body carries one (`mark_gemini_verification_required`),
  instead of keeping the response. Model discovery never marks, because Google answers listings with the
  same notice for accounts that still serve generations. Recovery and the
  verification probe are in
  [accounts-and-pools.md](./accounts-and-pools.md) and
  [ADR-0003](../decisions/0003-recoverable-agy-account-verification.md).

## Model discovery

Availability always comes from the live account; the reviewed catalogue
([provider-catalogue.md](../provider-catalogue.md)) supplies names, effort
metadata and the current lineup. Key clients and the Playground share
`models_for_selection`.

| Provider | Live source                                                            | Result                                                                           |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| ChatGPT  | `CHATGPT_CODEX_MODELS_URL`, then `chatgpt.com/backend-api/models`      | Official-docs lineup that the account also lists (`intersect_live_catalogue`)    |
| Claude   | `CLAUDE_MODELS_URL` (`…/v1/models?limit=1000`; the default page is 20) | Official-docs lineup that the account also lists                                 |
| Gemini   | `POST v1internal:fetchAvailableModels` with the project                | Reviewed chat models the account lists with a `displayName` and not `isInternal` |
| Grok     | `cli-chat-proxy.grok.com/v1/models-v2`                                 | Live list filtered to reviewed, non-deprecated chat models                       |
| DeepSeek | `<DEEPSEEK_API_URL>/models`                                            | Live list filtered to reviewed, non-deprecated chat models                       |
| Groq     | `<GROQ_API_URL>/models`                                                | Key route: filtered like DeepSeek. Playground path: unfiltered here (see below)  |

- ChatGPT tries the first URL and then the second, with `client_version`,
  `openai-beta: responses=experimental` and `version`. It returns the first answer
  that succeeds or is `401`/`403`; otherwise `provider_unavailable`.
- The official-docs lineup is parsed from the provider's docs page
  (`fetch_or_cached_openai_catalogue`, `fetch_or_cached_claude_catalogue`):
  ChatGPT's "Recommended models" section (slugs plus the GPT families named in the
  rollout paragraph) and Claude's "Compare models" table. Each result is cached for
  one hour, the fetch times out after 6 s, a stale copy is served when a fetch
  fails, and the bundled catalogue is the last fallback. A model that appears in the
  docs and in the live list is offered without a code change.
- For ChatGPT and Claude, live entries marked `active: false` or hidden do not
  count as available.
- Gemini's list is OpenAI-shaped (`{object: "list", data: [{id, object: "model",
owned_by: "google", name}]}`) rather than Google's native shape.
- Groq's list is filtered like Grok's and DeepSeek's: the live list intersected with
  the reviewed chat models. `apps/api/src/api/playground/mod.rs` adds the call
  entry for providers with a call profile (`provider_catalogue::call_available`).

## Organization usage recording

`organization_usage_events` rows are written only for organization-scoped requests,
which come from the Playground in organization mode (keys are personal and record
nothing). A row is written when all hold:

- the request is a `POST`, the upstream answered `2xx`, and it is not `count_tokens`
  or `countTokens`;
- the stream is read to its end without error and carries the provider's
  terminal marker (`UsageObserver`).

| Provider family               | Counts as complete                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT, Grok, DeepSeek, Groq | `response.completed` and no failure; or a Chat Completions `finish_reason` of `stop`, `tool_calls` or `function_call` followed by `[DONE]`. A `failed` or `incomplete` status never counts. |
| Claude                        | `message_stop` after a stop reason of `end_turn`, `stop_sequence` or `refusal` (`tool_use` and `max_tokens` turns are not recorded)                                                         |
| Gemini                        | candidate index 0 with `finishReason: STOP`                                                                                                                                                 |

A non-streaming JSON body is recorded unless its status is `failed` or
`incomplete`; Claude and Gemini JSON bodies also need their stop marker. A JSON
body over 1 MiB is not inspected: the request is recorded as complete with
unknown tokens.

Token counts come from the provider's usage object and stay `NULL` when it is
missing, which is distinct from zero. `input_tokens` includes cached input: Claude
sums `input_tokens`, cache-read and cache-creation tokens; Responses and Chat
Completions report it directly; Gemini uses `promptTokenCount`, with output as
`totalTokenCount − promptTokenCount` (or candidate plus thought tokens). Cached
tokens are stored separately. The observer reads at most 1 MiB per SSE event or
JSON body. A Codex voice session records one row at setup with unknown tokens.

## Playground-facing surface

These session-authenticated routes live in `apps/api/src/api/playground/`; the
mode logic is in [playground.md](./playground.md).

| Route                                                        | Purpose                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET /playground/{provider}/accounts/{connection_id}/models` | Account-scoped model list (`?organization_id=` for organization scope), with call models added |
| `POST /playground/chat`                                      | Streams one answer through the gateway engine                                                  |
| `POST /playground/voice`                                     | Creates a Codex realtime session from an audio-only SDP offer                                  |

The two `POST` routes share one budget of 30 requests per minute per user.

- The two `POST` routes authenticate first and require an allowed `Origin`; the
  models route needs only the session. The chat body is `{connection_id,
organization_id?, provider, model, messages}` with alternating user and assistant
  messages ending on a user message, at most four attachments per message and
  5 MiB each. Images are accepted
  only for providers whose `chat_capabilities` include `image_input` (ChatGPT,
  Claude, Gemini); text files join the prompt. The request is turned into the
  provider's native body (Claude Messages with `max_tokens: 4096`, Gemini
  `contents`, Responses `input` for ChatGPT, Grok, DeepSeek and Groq) and sent
  through the same engine. A call-only model such as `gpt-live-1-codex` is refused.
- `gateway/voice.rs` creates the Codex session with `openai-alpha: quicksilver=v2`
  and a 35 s timeout. Session creation is not idempotent, so a lost answer is never
  replayed; only an explicit refusal moves to the next account. The answer must be
  an SDP starting `v=0` with an `m=audio` line and is capped at 128 KiB.

## Clients

The tools in [tools.md](./tools.md) configure local coding agents against these
routes with a Hub key. `gateway.py` writes the native CLI configuration for Codex,
Claude Code, AGY and Grok; DeepSeek and Groq have no native CLI entry, so they are
reached through OpenCode and OMP. The OpenCode and OMP installers read each
provider's `models_path` from the catalogue, install only the models the Hub
returns and never add a model the live list lacks.
