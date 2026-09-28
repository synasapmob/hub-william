# ADR-0042: Piper local speech output

- Status: Accepted
- English-only output and fixed voice session superseded by [ADR-0043](0043-vietnamese-piper-speech.md).
- Fixed English output/session restored by [ADR-0044](0044-english-only-local-call-speech.md), which also makes Whisper input English-only.
- Date: 2026-09-28
- Authority: operator approved replacing local TTS with Piper after comparing Piper and Kokoro WebGPU, with Windows/Android/mobile compatibility as a requirement.
- Partially supersedes: the Kokoro implementation and phonemizer choice in [ADR-0041](0041-uniform-local-whisper-calls.md). Its provider routing, preload ownership, bounded streaming, cancellation and recording contracts remain current.

## Decision

Every Call Whisper provider uses browser-local Piper speech output. Whisper
still recognizes the microphone locally; the selected provider's existing Chat
API still generates streamed BOT text. Piper speaks that text in bounded
segments. This does not add native voice capability to a text model, alter Call
Live, upload audio, or call a remote TTS endpoint.

Use the English `en_US-ljspeech-medium` Piper ONNX voice at immutable revision
`840e38a7e26d813bd6221b78cfbaefa3585b3f71` of
`diffusionstudio/piper-voices`. The model is 63,531,379 bytes, SHA-256
`6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22`.
Its pinned config specifies `en` phonemization, mono 22,050 Hz PCM and inference
scales `[0.667, 1, 0.333]`. Keep those values together with the model. The model
card identifies its LJSpeech dataset as public domain; see the
[source dataset](https://keithito.com/LJ-Speech-Dataset/) and
[pinned model card](https://huggingface.co/diffusionstudio/piper-voices/blob/840e38a7e26d813bd6221b78cfbaefa3585b3f71/en/en_US/ljspeech/medium/MODEL_CARD).
This remains English BOT speech; Vietnamese input transcription is unchanged.

Run Piper inference and phonemization inside the existing dedicated TTS worker.
Reuse the app's pinned `onnxruntime-web/wasm` runtime and its matching bundled
WASM/module assets. Use one CPU thread without requiring WebGPU,
SharedArrayBuffer or cross-origin isolation. Do not introduce the Piper browser
wrapper's older ONNX runtime, mutable model discovery, singleton voice session,
or remote CDN defaults. Package `@diffusionstudio/piper-wasm` is pinned at 1.0.0
and supplies the phonemizer and its Vite-served WASM/data assets. Remove the
Kokoro-only `phonemizer` dependency and main-thread helper. Transformers.js stays
for Whisper recognition.

Load and verify the model plus phonemizer WASM/data once per worker. Bound reads
by the known asset sizes and verify SHA-256 before inference or caching. Cache
public assets in `hub-piper-speech-v1`, validate cache hits too, and discard a
corrupt entry before one fresh download. Omit credentials from these downloads.
Unavailable or full cache storage must not prevent synthesis; invalid downloaded
bytes must fail visibly and must never become cached model input. Model weights
remain outside the app bundle and are fetched from their pinned HTTPS URL.

Playground entry prepares this worker alongside Whisper and Silero. Start takes
the same resources; preparation never opens devices, plays speech or calls a
provider. The ONNX session persists for the call. Bounded per-segment phonemizer
instances reuse verified in-memory WASM/data, avoiding repeated asset fetches.
Transfer raw 22,050 Hz PCM to the existing player and local recording mix; do
not relabel the samples as 24 kHz or change playback speed.

Preserve the 240-character segment bound, worker load/synthesis timeouts,
bounded audio output, immediate BOT text streaming and buffered playback.
Barge-in cancels generation and queued playback and ignores obsolete local
results. End/navigation terminates the worker; no mid-inference cancellation
claim and no automatic provider retry or remote speech fallback.

## Verification and limits

Verify actual Piper synthesis in development and built worker assets, native
22,050 Hz playback and recording, repeated calls/cache reuse, corrupt downloads,
unavailable storage, cancellation and shared provider routing. Exercise desktop
Chrome, Firefox and WebKit with the implementation's actual runtime. Real
Windows, Android and iPhone hardware, memory pressure and background behavior
still require device testing; desktop engines or a mobile viewport are not
substitutes for that evidence. A single English phrase benchmark is not a
universal latency or subjective voice-quality guarantee.

The initial built-worker checks verified synthesis and playback in all three
desktop engines. Chrome and Firefox retained verified assets across worker
replacement and reload. In the tested WebKit 26.6 runtime, successful Cache API
writes were not reliably retained after worker termination or page reload.
Treat this as a known cache limitation: speech still works with a fresh
download, and persistent/offline Piper availability on Safari is not claimed.
Keep the failed persistence check in the evidence rather than treating audio
playback as proof of durable storage.
