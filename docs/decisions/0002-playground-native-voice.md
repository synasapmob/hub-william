# ADR-0002: Call Live exists only where a native call transport is verified

- Status: Accepted
- Date: 2026-09-26, revised 2026-10-27 to describe current behaviour

## Context

Live probes with a ChatGPT Plus OAuth connection established native audio input
and speech output through the Codex V3 WebRTC protocol. The verified model is
`gpt-live-1-codex`. Ordinary Codex text models did not accept the tested audio
schema. The tested Grok credential was denied voice access, the tested DeepSeek
models rejected audio input, and AGY recorded-media understanding does not
establish live speech output. Camera perception is not verified for any
provider.

## Decision

- Call Live is offered only for a provider with a verified native call
  transport and model: ChatGPT with `gpt-live-1-codex`, the catalogue's
  `native_realtime` profile. A future provider needs a verified transport and
  model capabilities first, and transcription-only models do not qualify.
- The model comes from the native voice protocol, not the text catalogue. When
  an account has at least one current chat model, the API adds the dedicated
  entry (Codex Voice, mode `voice`) to ChatGPT discovery. Ordinary text models
  are never marked voice-capable and never substituted.
- There is no fallback between modes. When a provider has no model for the
  selected mode, the Model select lists none and Start stays disabled. The user
  picks another mode; the app never switches for them. Call Whisper is its own
  mode built from Chat and browser-local speech, not a degraded Call Live.
- Account entitlement is tested only when the provider creates the session, and
  the failure stays visible.
- The Playground route builds and validates the Codex V3 session
  (`apps/api/src/api/playground/voice.rs`), and the gateway exchanges an
  audio-only SDP offer from the browser with the provider
  (`apps/api/src/api/gateway/voice.rs`). Only the SDP answer
  reaches the browser; provider credentials, upstream URLs, browser headers and
  tool settings are neither exposed nor passed through.
- Session creation is not idempotent. It has a bounded timeout, is never
  replayed after a network failure or a lost answer, and moves to the next
  account in scope only on an explicit refusal.
- Audio flows between the browser and the provider over WebRTC. Native
  transcript events fill an in-memory log for both speakers. Start needs a user
  action. End, a mode change, a page change, a failed setup and a disconnect
  release the peer connection and every media track. There is no automatic
  reconnect and no tool execution.
- The camera is a local preview and is never attached to the upstream peer,
  because video perception is unverified. Denying the camera does not block
  audio.
- An organization usage event is recorded once, when setup succeeds, with
  unknown token counts. Audio and token events bypass the API, browser-reported
  usage is not trusted, and unknown counts are never shown as zero. A
  successful setup does not show that the conversation completed.

## Consequences

- The native subscription endpoint is version-sensitive and can reject an
  account. The UI reports that without claiming every subscription can call.
- The protocol was verified with a ChatGPT Plus account. On 2026-10-27 two
  Free-plan accounts both received HTTP 404 `{"detail":"Not Found"}` from the
  call route, although the request matches the official Codex client (path,
  query, JSON body, `openai-alpha: quicksilver=v2`, `x-session-id`). A paid plan
  is the likely requirement; it has not been confirmed with a paid account.
- A video-style layout does not mean the BOT sees the camera.
- Live entitlement probes do not prove browser behaviour, so media lifecycle
  needs its own checks.

See [Playground](../architecture/playground.md) for the full mode logic.
