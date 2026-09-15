# ADR-0021: Transparent request sizing for agent gateway routes

## Status

Accepted — 2026-09-15.

## Context

The public frontend's nginx container proxies `/api/*` to the private Rust API.
Nginx's default one-mebibyte request-body limit rejected a real DeepSeek coding
session at approximately 1,046 KB before the request reached the API. The
session contained about 241,000 stored tokens, below the live model's advertised
context window. Axum's default body-extractor limit would independently reject
larger gateway requests above two mebibytes.

The shared provider HTTP client also had a 30-second total request timeout. A
real OMP turn reached DeepSeek, began streaming, and was then cut off at that
boundary before `response.completed`; OMP correctly reported a non-terminal
Responses stream and retried it.

Hub William is a transparent provider gateway. It does not own input or output
token policy and must not silently impose a smaller context budget than the
selected provider or the user's client configuration. Browser authentication,
pool administration, Telegram, and other control-plane routes are separate and
do not need unrestricted coding-context payloads.

## Decision

- Disable nginx request-body sizing for the public `/api/gateway/*` location
  with `client_max_body_size 0`.
- Disable Axum's default body-extractor limit only on the Rust `/gateway/*`
  router.
- Use a dedicated gateway HTTP client with no total request-duration timeout.
  Keep the connection-establishment timeout so unreachable upstreams still
  fail promptly; nginx's read timeout remains an idle-between-bytes liveness
  check, not a total generation timer.
- Preserve the framework and nginx defaults for every non-gateway API route.
- Do not inject default input-token, output-token, context, or request-size
  limits in either installer. A user may configure a client-side limit; an
  upstream provider may enforce its own documented contract.
- Keep protocol compatibility transforms separate from policy. For example,
  removing an unsupported field at a subscription endpoint makes the request
  acceptable but must not replace it with a Hub-defined token ceiling.
- Cover both boundaries with tests: the nginx deployment contract scopes the
  unlimited directive to the gateway location, while an API test proves a body
  above the former 16 MiB proposal reaches gateway authentication and remains
  rejected on a browser route.

## Consequences

- OMP and OpenCode can use the provider's available context and generation
  duration without a Hub-owned 413 or 30-second cutoff.
- Gateway request buffering is no longer protected by a Hub-specific size cap.
  Authentication, membership checks, pool controls, provider limits, and
  infrastructure capacity remain applicable; this trade-off follows the
  operator's explicit transparent-gateway policy.
- Non-gateway endpoints retain bounded request bodies and are unaffected.
