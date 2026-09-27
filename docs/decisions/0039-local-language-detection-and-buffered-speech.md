# ADR-0039: Local language detection and buffered speech

- Status: Accepted
- Date: 2026-09-27
- Authority: operator requested Vietnamese/English transcription and approved buffering one or two BOT speech chunks while text continues streaming.
- Partially supersedes: the model and English-only recognition choice in [ADR-0037](0037-browser-local-speech-recognition.md), and immediate per-chunk playback in [ADR-0034](0034-playground-call-streaming-and-interruption.md).

## Decision

Run multilingual `onnx-community/whisper-base`, pinned to revision
`1846881b6b3a3024392c1eea3ad983695bc23925`, in the existing browser worker.
Before each transcription, generate one language token from the audio features,
restricting selection to the model's declared language tokens. Then transcribe
with that language and `task: transcribe`. Transformers.js 4.3.0 does not provide
working automatic language detection simply by omitting the language option.
This explicit language probe keeps Vietnamese speech as Vietnamese instead of
forcing English output. Mixed-language utterances still have one dominant
language; recognition is fallible and device dependent.

Keep WebGPU and quantized WASM paths, cached model downloads, incremental YOU
updates, two-second silence, and no audio upload or remote STT fallback. Base
requires a larger first download than the previous tiny model. Local decoding
can finish after cancellation: ignore its obsolete results; End terminates the
worker. The installed Whisper wrapper does not forward stopping criteria to its
generation implementation, so do not promise mid-token cancellation.

BOT text continues to update immediately from SSE deltas. Decode audio while
earlier audio plays, retain at most two ready and two scheduled buffers, and
schedule sources against the AudioContext clock. Initially buffer two chunks,
flush a final single chunk when the response completes, or start after a maximum
1.2-second buffer wait. Rebuffer after an upstream underrun. Retain encoded and
decoded total-size limits. This removes the client's decode-after-play ordering;
it cannot guarantee continuity when upstream speech arrives too slowly.

Every source connects to both playback and the local recording mix. Barge-in,
End and failure stop all scheduled sources and discard late decode results.
Backend API, provider quota, account access and transcript contracts stay the
same; buffering itself does not generate extra model output or TTS requests.

## Verification boundaries

Tests cover language-token selection, tensor cleanup, bounded predecode,
clock-based scheduling, final single-chunk playback, underflow and interruption.
Real-browser checks exercise Vietnamese synthetic speech and recorded English
with the actual model, plus call playback with fixture SSE audio. These checks
establish language preservation and lifecycle behavior, not perfect recognition
for every accent or continuous audio under every network condition.
