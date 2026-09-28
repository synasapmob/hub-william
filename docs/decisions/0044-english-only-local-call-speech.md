# ADR-0044: English-only local call speech

- Status: Accepted
- Date: 2026-09-28
- Authority: operator explicitly requested English-only Whisper, no second language and hard-coded `en` throughout local call speech.
- Supersedes: [ADR-0043](0043-vietnamese-piper-speech.md).
- Partially supersedes: language detection and multilingual transcription in [ADR-0039](0039-local-language-detection-and-buffered-speech.md), and multilingual input support in [ADR-0041](0041-uniform-local-whisper-calls.md). Their buffering, routing, lifecycle and recording contracts remain current.
- Restores: the fixed English Piper voice/configuration from [ADR-0042](0042-piper-local-speech-output.md).

## Decision

Call Whisper local speech supports English only. Set `language: "en"` on every
Whisper transcription and keep `task: "transcribe"`. Remove the language-token
probe and its detector module. Retain the already pinned
`onnx-community/whisper-base` model and revision
`1846881b6b3a3024392c1eea3ad983695bc23925`; an English language parameter does
not require introducing a different model download. Both WebGPU and quantized
WASM paths use the same fixed language.

Piper uses only the pinned `en_US-ljspeech-medium` model and eSpeak `en` from
ADR-0042. Remove Vietnamese model configuration, text-language heuristics,
language options in the local TTS interface/protocol and per-language session
switching. Keep one initialized English session for the call, native 22,050 Hz
PCM, verified asset caching, the 240-character segment bound, the 180-second
initial load timeout and 60-second synthesis timeout.

Whisper and Piper remain browser-local. Provider-generated text and Call Live
are unchanged; this configures local speech rather than translating or filtering
provider replies. No claim is made that forced-English transcription accurately
handles speech in other languages. Existing cancellation, VAD, preloading,
provider routing, playback and local recording behavior remain in place.

## Verification

Replace removed multilingual-detector and voice-switching tests with regression
checks that both Whisper runtime paths always pass `en`, do not run a language
probe, and that Piper always uses English model metadata, phonemization and
inference scales. Preserve existing cancellation, bounds, timeout and PCM tests.
Exercise English recognition/synthesis through the actual default browser speech
resource and verify the production build.
