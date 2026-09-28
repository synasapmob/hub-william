# ADR-0043: Vietnamese Piper speech

- Status: Superseded by [ADR-0044](0044-english-only-local-call-speech.md).
- Date: 2026-09-28
- Authority: operator requested adding the Vietnamese Piper voice and testing locally against staging, then confirmed that BOT text was correct Vietnamese while its spoken output was unintelligible.
- Partially supersedes: the English-only output and single fixed voice session in [ADR-0042](0042-piper-local-speech-output.md). Its local execution, asset verification, playback, cancellation and recording requirements remain current.

## Decision

Call Whisper chooses the Piper voice from each bounded BOT text segment. Text
containing Vietnamese accented letters uses `vi_VN-vais1000-medium`; otherwise
it uses the existing `en_US-ljspeech-medium`. Normalize Unicode to NFC for this
check. The check is a local Vietnamese/English heuristic, not a general
language classifier: unaccented Vietnamese is ambiguous, other languages can
share accents, and a mixed-language segment uses one voice. Do not translate,
rewrite or send BOT text to a remote language-detection or speech service.
Whisper input detection and the selected provider's generated text are unchanged.

Pin the Vietnamese voice to revision
`c10ece1aade47bb51c153c893d14e5bf8e5b7117` of `rhasspy/piper-voices`.
The ONNX model has 63,201,294 bytes and SHA-256
`ec7c89e2c85f4d1edc24b6120c18aaf1bda614f06b511567eb9c7c0de15e2dab`.
Its [published config](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx.json)
specifies eSpeak `vi`, mono 22,050 Hz output and inference scales
`[0.667, 1, 0.8]`. Keep model identity, phonemizer and scales together.
Voice credit: Rhasspy Piper voices, trained on VAIS-1000; the
[model card](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/vi/vi_VN/vais1000/medium/MODEL_CARD)
lists the dataset's [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/)
and fine-tuning from the English Lessac voice. Original model weights are used
without modification.

Keep one dedicated TTS worker and one live ONNX session. Page preparation
continues to warm English. The first Vietnamese segment downloads and verifies
the Vietnamese model using the existing cache. Before switching languages,
finish any active inference, verify the next model and phonemizer, then release
the previous session. Consecutive segments in the same language reuse the
session; switching back loads verified bytes from cache where available.
Phonemizer WASM/data stay shared within the worker. No second persistent
language worker or simultaneous inference session is introduced.

Allow up to 180 seconds for loading/queuing a selected voice, followed by the
existing 60-second synthesis limit. The worker reports when the model is ready
for synthesis; repeated progress cannot extend that deadline. Barge-in rejects
the caller immediately, ignores late work and serializes the next voice change
after the canceled inference finishes. End still terminates the worker.

## Verification and limits

Cover automatic Vietnamese/English selection, decomposed accents, both voice
configurations, session release/reuse, cancellation while downloading or
inferring, and separate load/synthesis deadlines. Exercise the default
preload/take speech resource and actual Vietnamese synthesis in a browser,
rather than only an explicitly selected standalone worker. Verify the bundled
worker too. Existing device and Safari cache limitations from ADR-0042 remain;
one phrase or an automated speech-recognition round trip is not a general
pronunciation-quality guarantee.
