# ADR-0034: Saved media choices and interruptible Groq calls

- Status: Accepted
- Audio playback buffering partially superseded by [ADR-0039](0039-local-language-detection-and-buffered-speech.md).
- Partially superseded by [ADR-0037](0037-browser-local-speech-recognition.md) for remote STT and audio input; streaming, silence and interruption behavior remain.
- Date: 2026-09-27
- Partially supersedes: ADR-0033's 800 ms silence and alternating capture/playback.

## Context

The operator requested persisted Voice/Camera choices, incremental BOT text,
speaking while BOT answers, and approximately two seconds to pause before a
spoken turn is sent.

## Decision

- Store only the desired Voice/Camera booleans in browser localStorage under
  `hub.playground.media`. Default both on for first use. Reload and End call
  retain these choices; they never start a call or acquire devices automatically.
  Start applies them before sending microphone audio or opening camera capture.
  Storage errors fall back to in-memory controls. Device cleanup never changes
  the saved choices; the camera preview still reflects actual capture.
- Groq capture waits for 20 consecutive 100 ms silent frames. Speech resets
  that countdown. Existing 300 ms pre-roll and 20-second audio bound remain.
  The Speaking label stays through the pause; its waveform flattens when input
  is quiet. Only submission changes the label to Waiting for BOT.
- While speaking, submit a cumulative WAV snapshot no more frequently than every
  1.5 seconds, with at most one transcription request in flight. The separate
  authenticated `POST /playground/groq/voice/transcription` endpoint performs
  only STT and returns SSE `transcript` then `done`; it never starts LLM/TTS or
  records a conversation usage event. It reuses the same account/origin/WAV
  validation, credential isolation, permit and cancellation cleanup as a turn.
  Each result replaces one provisional YOU row and may revise earlier words.
  The final full-turn transcription replaces it after the two-second pause.
  Draft text is excluded from history; empty final recognition removes the draft.
  Mute/End/submission cancel previews and reject late results. Snapshots and
  transcripts stay in memory. Repeated STT snapshots consume extra provider
  requests/audio quota; this is near-live transcription, not native streaming STT.
  Previews stop when this call has sent 12 STT requests in the rolling minute,
  reserving headroom for final turns under Groq Free's documented 20 RPM limit.
  Final turns are never blocked by this preview budget. When the window clears,
  previews resume; shared-account traffic and daily/audio limits still apply.
- The client discards a first Groq transcript containing no Unicode letters or
  numbers, and treats the current API's explicit no-speech error as an empty
  turn. No user/BOT row or playback is produced; the same call keeps listening.
  Cancel the response reader immediately. The API also rejects such final
  transcripts before starting LLM/TTS; interim recognition instead returns empty
  text. These checks do not detect hallucinated actual words.
- Keep microphone capture active during generation and playback. Two consecutive
  voiced frames interrupt the current Groq turn: abort its HTTP request, stop
  playback, discard queued clips, and ignore late callbacks. The ongoing user
  recording is retained and submitted after its silence window. Echo cancellation
  is requested from the browser; acoustic echo performance remains device-dependent.
- `POST /playground/groq/voice/turn` accepts optional `stream: true`. After the
  existing session, origin, input and selected-account gates, return SSE with JSON
  `type` values: `transcript` (`text`), `delta` (`text`), `audio` (base64 `audio`),
  then `done`; failures use `error` (`message`). Omitted/false `stream` preserves
  JSON compatibility for clients open before deployment.
- Optional `stream_audio: true` with `stream: true` opts into interleaved `delta`
  and `audio` events after the initial transcript, with `done` only after both
  generation and ordered audio finish. Clients omitting this flag retain the old
  all-text-before-audio stream order. Clients must update before requesting it.
- Forward Groq Chat Completions content deltas as they arrive. Do not simulate
  streaming after a completed response. Transcription appears before text
  generation. With early audio enabled, commit complete sentences or bounded
  word chunks to an eight-item queue and synthesize them serially while reading
  new text. Each TTS input stays within 200 Unicode characters; flush the final
  fragment only after successful LLM completion. Text is never regenerated or
  replayed to synthesize a later sentence. Frontend plays each clip as it arrives.
  Queue/LLM/TTS futures share the turn lifetime: failure or disconnect drops all
  pending work. Audio already heard before a later upstream failure cannot be
  undone. Existing byte, text, timeout and success-only usage limits still apply.
- Disconnect cancels pending upstream work and still releases the half-open
  probe and process-local account permit. A replacement request can wait up to
  four seconds for bounded cleanup, then rechecks access and availability.
  No automatic provider retry, fallback account or generation replay is added.
- Transcript entries keep stable IDs. Interrupted text remains visible; the
  next turn's bounded history includes only text already delivered to the UI.
  Audio, transcript and conversational history remain in memory. Existing
  successful-turn-only organization usage accounting remains: an interrupted
  partial pipeline is not represented as a completed turn. Aborting cannot undo
  work already accepted by Groq, and provider billing may include that work.
- Native Codex V3 already carries incremental transcript events and simultaneous
  input/output audio. Its verified contract exposes no configurable silence
  duration or per-turn cancellation event. Preserve those native semantics;
  do not invent public Realtime `session.update`/`response.cancel` events for V3.
  Therefore Hub's exact two-second pause and interruption guarantees apply to
  the composed Groq path. Saved media choices apply to both transports.

## Sources and verification boundary

The current [Groq streaming contract](https://console.groq.com/docs/text-chat)
uses `stream: true` and `choices[0].delta.content`.
The [Groq rate limits](https://console.groq.com/docs/rate-limits) document the
Free Whisper Turbo 20 RPM allowance; the preview budget is per call and does not
replace the provider's shared account quotas.
The Codex V3 boundary is the pinned native source documented in ADR-0032.
Transport fixtures test incremental delivery, cancellation and cleanup;
browser fixtures test real audio capture/playback with synthetic media. These
do not establish live provider entitlement, microphone quality or echo rejection.
