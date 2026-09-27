# ADR-0041: Uniform local Whisper calls and speech preparation

- Status: Accepted
- Date: 2026-09-27
- Authority: operator approved the same local STT and TTS flow for Groq, AGY/Gemini, DeepSeek, Grok, Claude and ChatGPT, then requested model preparation on entering Playground.
- TTS implementation partially superseded by [ADR-0042](0042-piper-local-speech-output.md); provider routing and lifecycle decisions below remain current.
- Partially supersedes: the Groq-only selector and remote Orpheus output in [ADR-0037](0037-browser-local-speech-recognition.md), and the frontend composed-call availability rule in [ADR-0038](0038-shared-provider-model-catalogue.md).

## Decision

Call Whisper is a browser speech layer around the existing account-scoped Chat
API. Offer every connected chat-capable Playground provider and only the selected
account's API-advertised chat models. Keep their exact IDs. No native voice or
Orpheus entitlement is required, including for Groq. Derive eligibility from the
canonical provider chat capability rather than duplicating provider/model lists
or advertising native voice support for text models.

Send the finalized local transcript and paired conversation history to
`POST /playground/chat`, pinned to the selected provider, connection and optional
organization. The model uses its normal Chat behavior. There is no hidden tutor
message or additional model generation. Keep real streamed BOT text; queue
bounded sentence segments for local speech while the response continues.
Groq no longer calls its voice-turn endpoint from this UI. Existing backend
Groq voice profiles/endpoints remain compatible with older clients; native
Call Live retains its existing WebRTC/profile contract.

Use [Kokoro 82M v1.0 ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
with English `af_heart` voice, q8 WASM inference, and revision
`1939ad2a8e416c0acfeecc08a694d14ef25f2231`. Model and voice weights use that same
revision. The model is Apache-2.0. Use the already installed Transformers.js
4.3.0 runtime and `phonemizer` 1.2.1; do not add another Transformers/ONNX version.
Serve the phonemizer's standalone generated module as an unchanged Vite asset:
transforming it produced an empty eSpeak voice table in both worker and window
browser probes. Phonemization runs on the main thread for bounded text segments;
neural synthesis runs in a dedicated worker. Return transferable mono 24 kHz
PCM directly to the buffered player and recording mix.

The output voice is English, matching the previous Orpheus English voice scope.
Vietnamese and English microphone transcription remain unchanged; this does not
claim Vietnamese BOT speech. The chosen chat model's text is not translated or
rewritten for TTS. Voice quality and synthesis latency depend on the device.

Entering Playground starts model preparation for local Whisper, Silero and
Kokoro in parallel. It does not open devices, create an AudioContext, begin a
conversation or call a provider. Start call takes ownership of those same
workers, including an in-progress download; it does not load a duplicate set.
Leaving the page aborts unclaimed preparation. End, failure and navigation
during a call terminate the claimed workers. A later call may initialize again
from cached model assets. Failed background preparation is retried on a new
page entry or explicit Start call, with no automatic retry loop while mounted.
Persistent failure is shown when starting the call.

Retain the VAD gate, pre-roll, two-second silence, provisional YOU updates,
streaming BOT text, saved media choices and local recordings. Only paired user
and assistant rows enter follow-up context, so interruption before the first
BOT delta cannot send consecutive user messages. Barge-in cancels the Chat
request, queued speech and scheduled playback; ignore a late local inference
result. End terminates inference. Do not claim mid-inference cancellation.
Bound text segments, reply length, queued audio bytes and load/inference time.
There is no remote STT/TTS fallback and no automatic replay of a generation.

## Verification

Cover all six provider/account bindings, chat-only model selection, legacy mode
migration, streaming/cancellation, paired history, PCM recording connections and
preload ownership. Browser checks must use actual local models, observe zero
device/provider activity during preparation, and exercise speech through the
selected account's Chat transport. Provider fixtures establish frontend wiring,
not live account entitlement or recognition quality for every microphone.
