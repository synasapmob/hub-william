# ADR-0025: Session-backed model Playground

- Status: Accepted
- Date: 2026-09-23
- Partially supersedes: ADR-0024's demo-only Playground scope

## Context

The operator approved the standalone Playground flow and requested applying it
to the application with real model requests.

## Decision

- `/playground` remains publicly viewable. Sending messages and discovering
  account-scoped models require the existing Hub browser session. Providers remain
  selectable publicly; the account control is disabled while signed out. Accounts
  come from the existing pool directory; only owned/joined accounts are selectable.
  Select the first accessible account by default for each provider, and leave the
  control empty when that provider has none.
- The browser does not create, retain or request a gateway key. Session handlers
  resolve the user on the server and call the existing in-process gateway.
  Existing gateway-key routes retain their authentication contract.
- Pin each request to the explicitly selected connection, after checking provider
  and owner/accepted-member access. Never fall back to another account. Reuse encrypted credentials,
  refresh, cooldown and bounded retries. Do not forward browser headers upstream.
  Chat POST requests authenticate before body parsing, require an accepted Origin,
  and have a 32 MiB body limit mirrored by nginx.
- Model choices come from the selected account's provider catalogue: ChatGPT's
  Codex models endpoint (with its legacy path fallback), Claude's models
  endpoint with the full 1000-item page limit, Gemini's available models, and
  Grok/DeepSeek's model endpoints.
  Preserve only provider-advertised IDs; upstream rejection remains explicit.
  The Playground picker narrows ChatGPT and Claude to the current general text
  lineup from their official model documentation, intersected with that
  account's catalogue. Older advertised versions remain available to existing
  gateway clients but are not offered in Playground. If that intersection is
  empty, the Model control stays disabled and identifies the empty current
  lineup without replacing the conversation introduction.
- Support text conversations for ChatGPT, Claude, Gemini, Grok and DeepSeek.
  Use their existing Responses, Messages or Gemini streaming protocols. Claude
  requests specify a 4096-token output budget; reaching it is an incomplete turn.
- Render completed assistant text as Markdown without activating raw HTML or
  remote Markdown images. Preview SVG returned as text through a sanitized
  image-only data URL, and keep its source available. This does not add native
  provider image generation or PNG output to the text-only stream contract.
- Enter sends, Shift+Enter inserts a newline, and IME composition does not submit.
  An empty or whitespace-only draft without attachments does nothing and shows
  no validation error.
- Accept up to four 5 MiB attachments per message: PNG/JPEG/GIF/WebP images for
  ChatGPT/Claude/Gemini, UTF-8 text/code files for all providers, and locally
  extracted text from PDFs. Reject unreadable/scanned PDFs and unsupported binary
  formats rather than claiming provider-native file support. Attachments remain
  in memory and are included in completed conversation history.
- Voice interaction mode is awaiting operator clarification; it is not implemented
  by this decision.
- Retain visible conversation text only in the mounted page. Leaving the page or
  changing the signed-in user clears it. Follow-up requests replay completed
  question/answer pairs; stopped or failed turns are displayed but excluded from
  subsequent context. Do not persist transcripts or execute model tool calls.
- Stop cancels the browser request. Never replay generation automatically after
  streaming begins. A truncated, failed or unreadable stream is not success.
- Show a failed generation as the assistant's message beneath its submitted
  user turn. Show setup and unsent input errors in the conversation area, not
  in separate setup or composer alerts.
- Use React Hook Form for the compose workflow, TanStack Query for server state
  and mutations, and a service-owned stream parser. No production mock responses
  or demo accounts remain in the route.

## Consequences

Playground requests consume the same provider quota as other gateway clients.
The browser can try a model without copying credentials. Live provider behavior
requires verification against a configured backend; isolated provider fixtures
prove protocol handling and authorization but do not prove upstream entitlement.
The standalone `preview.hmtl` remains a separate design artifact.
