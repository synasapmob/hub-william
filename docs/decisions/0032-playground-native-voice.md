# ADR-0032: Native voice in Playground

- Status: Accepted
- Date: 2026-09-26
- Partially superseded by: [ADR-0033](0033-groq-api-key-chat-and-call.md), which adds an explicitly composed Groq Call transport.
- Partially supersedes: ADR-0025's unimplemented voice scope and ADR-0029's text-catalogue-only Playground picker, only for the dedicated voice model below.

## Context

The operator requested a Chat/Voice selector, a basic BOT/local-camera layout,
and transcripts from both speakers. Live probes with an existing ChatGPT Plus
OAuth connection established native audio input and speech output through the
Codex V3 WebRTC protocol. The verified model is `gpt-live-1-codex`; ordinary
Codex text models did not accept the tested audio schema. Camera perception has
not been verified. AGY recorded-media understanding does not establish live
speech output; the current Grok credential was denied voice access and the
tested DeepSeek models rejected audio input.

## Decision

- Setup defaults to Chat and offers Chat/Call before account and model
  selection. The 2026-09-27 operator refinement replaces the original
  model-first Chat/Voice picker: both modes remain selectable, Chat lists all
  chat providers, and Call lists only providers with an implemented native
  call transport, currently ChatGPT. Provider visibility does not depend on
  having an account. Setup order is Organization, Mode, Provider, Account,
  Model. Account access and discovery remain unchanged; Account and Model
  show "Sign in to continue" when no account is available.
- Filter account-scoped models by their declared mode; do not mix chat-only
  and call-only models. Call displays each model's exact ID. The API keeps
  its existing `chat`/`voice` capability values and `/playground/voice` route;
  Call is the UI label for `voice`. Selecting an account or organization
  preserves the mode. Changing mode retains an account when its provider
  supports the destination mode, otherwise it selects a supported provider.
- After successful account-scoped ChatGPT text discovery with a nonempty
  current lineup, add the verified dedicated `gpt-live-1-codex` entry as
  **Codex Voice** in API metadata, with Voice as its only mode; the Call picker
  displays **gpt-live-1-codex**. It comes from the native Codex
  voice protocol, not the text catalogue. Do not mark ordinary text models as
  voice-capable or substitute one model for another silently. All other model
  discovery filters remain in place. Account entitlement is checked when the
  provider creates the session; failures stay visible.
- `POST /playground/voice` authenticates the Hub session and accepted Origin
  before parsing its bounded request. Reuse the selected account's
  owner/accepted-pool-member or organization-member access, provider check,
  credential refresh, and cooldown. Never fall back to another account.
- The server builds the Codex V3 session (`quicksilver=v2`,
  `gpt-live-1-codex`, `cove`) and exchanges an audio-only browser SDP offer.
  Only the SDP answer reaches the browser. Provider credentials, arbitrary
  upstream URLs, browser headers, and tool settings are not exposed or passed
  through. This non-idempotent session creation has a bounded timeout and is
  not automatically replayed on network failure or a lost answer.
  An explicit Hub `401 unauthorized` before upstream work may refresh the
  browser login and retry once, matching the existing chat authentication flow.
- The browser sends microphone audio and receives BOT audio directly over
  WebRTC. Native V3 transcript events populate an in-memory log for both
  speakers. Start requires a user action; End, mode changes, page changes,
  failed setup, and disconnects release the peer and all media tracks,
  including late permission grants. No automatic reconnect or tool execution.
- Show BOT and local camera panels. Camera is explicitly a local preview and
  is never attached to the upstream peer. Camera denial does not prevent
  audio. Microphone mute and camera toggles are available during a call.
  Call shows this layout and "Ready to talk" immediately, including while
  signed out or without an account. Start stays disabled until account/model
  selection is ready and discovery has succeeded. Discovery errors remain
  visible and retryable. A future provider needs a verified call transport
  and model capabilities before joining Call; transcription-only models do
  not qualify as a two-way call.
- Organization usage counts one successful voice-session setup, with unknown
  token counts. Audio and token events bypass the API over WebRTC; do not trust
  browser-reported usage or label unknown token counts as zero. A successful
  setup is not evidence that an entire conversation completed.
- Keep chat and voice transcripts in the mounted page only. Text chat retains
  its existing attachment, cancellation, and history behavior. Camera
  understanding, pronunciation scoring, persistent transcripts, and provider
  voice support beyond the verified protocol are outside this change.

## Consequences

The native subscription endpoint is version-sensitive and may reject an
account. The UI reports that failure without claiming all subscriptions can
call. A video-style layout does not imply the BOT can see the camera.
Backend protocol/access tests and browser media lifecycle checks accompany the
implementation; live entitlement probes alone do not prove browser behavior.
