# ADR-0037: Browser-local speech recognition

- Status: Accepted
- Model and English-only recognition partially superseded by [ADR-0039](0039-local-language-detection-and-buffered-speech.md).
- Date: 2026-09-27
- Authority: operator requested local STT with incremental transcripts and removal of backend STT to avoid Groq transcription quota.
- Partially supersedes: remote STT, audio input and Call selector portions of [ADR-0033](0033-groq-api-key-chat-and-call.md) and [ADR-0034](0034-playground-call-streaming-and-interruption.md).

## Decision

Groq Call recognizes the microphone in a browser Web Worker using Transformers.js
4.3.0 and `onnx-community/whisper-tiny`, pinned to revision
`ff4177021cc41f7db950912b73ea4fdf7d01d8e7`. Prefer WebGPU and fall back to quantized
WASM on the same device. Public model assets download on first use and use the
browser cache. Show loading during initialization and allow End to cancel it.
Do not upload microphone audio, use a remote browser speech service, or fall back
to Groq STT when local recognition fails.

Use English recognition for the existing English practice flow. This library
version defaults to English and does not implement automatic language detection;
the explicit language setting documents that limitation. Model loading and
inference speed depend on the browser, device and cache.

While the user speaks, bounded cumulative PCM snapshots update one provisional
YOU row using actual decoded token callbacks. Keep at most one preview active.
After two seconds of silence, cancel obsolete preview work and finalize the same
row locally. Keep the existing 20-second capture limit, noise/VAD gates and
punctuation-only rejection. Mute, End and interruption discard obsolete results;
End terminates the worker. Worker loading and decoding have bounded timeouts.

`POST /playground/groq/voice/turn` now accepts `transcript` text, bounded history
and the selected account/organization. Limit current text to 8,000 UTF-8 bytes,
require a letter or number, reject unknown audio fields, and cap the request body
at 64 KiB. Remove `/playground/groq/voice/transcription` and all backend Whisper
requests. Authentication, origin, account access, concurrency, cancellation,
cooldown and completed-turn usage accounting remain.

The backend only generates GPT-OSS replies and Orpheus speech. Preserve real BOT
text deltas and sentence audio before the complete response. Groq Call selects
`openai/gpt-oss-20b`; the canonical Call profile requires its chat and TTS models,
without requiring Whisper in the key's live model list. Merge Chat and Call modes
on the same model entry. Recognition consumes local resources; LLM/TTS still
consume their provider quotas.

Native ChatGPT WebRTC, local recording storage, media preferences and setup-query
refresh behavior are unchanged. Camera remains a local preview.

## Verification boundaries

Unit tests cover partial/final text, no audio transport, two-second turn taking,
mute/end/interruption and worker cleanup. Backend integration uses a transcription
trap to assert zero upstream STT calls, exercises the removed route and text
validation, and preserves access, streaming, cancellation and usage assertions.
Real-browser verification runs the actual model against recorded speech; this
does not establish recognition accuracy for every microphone, accent or device.
