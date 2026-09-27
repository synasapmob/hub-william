# ADR-0040: Browser speech activity detection before Whisper

- Status: Accepted
- Date: 2026-09-27
- Authority: operator requested Silero VAD from the LiveKit documentation, then specified microphone noise/echo handling, speech confirmation before Whisper, provisional transcripts and audio padding before speech onset.
- Partially supersedes: RMS-only local-call speech detection in [ADR-0034](0034-playground-call-streaming-and-interruption.md) and [ADR-0037](0037-browser-local-speech-recognition.md).

## Decision

Keep microphone capture in the browser with `echoCancellation`,
`noiseSuppression` and `autoGainControl` requested from the device. Run Silero
speech detection in a separate browser worker before local Whisper. The
[LiveKit Silero documentation](https://docs.livekit.io/agents/logic/turns/vad/)
describes its Agents plugin; this implementation uses the underlying model in
the browser without adding an AgentSession or server-side audio transport.

Use `onnx-community/silero-vad` pinned to
`e71cae966052b992a7eca6b17738916ce0eca4ec`, with the float32 ONNX model and
single-threaded WASM. Pin the direct ONNX Runtime dependency to the same version
already used by Transformers.js. Cache the public model asset when browser
storage permits; no microphone audio is cached or uploaded by detection.

Classify continuous 16 kHz mono audio in 512-sample windows with the model's
64-sample context and recurrent state. Aggregate speech probability over the
existing 100 ms capture frames; 0.5 is the speech threshold. Retain the existing
minimum two positive frames, 300 ms pre-roll, two-second silence and 20-second
capture bound. RMS remains a visual meter value, not permission to transcribe
or interrupt BOT playback. Noise classified as non-speech never initiates
Whisper, creates a draft, or interrupts a reply.

Start local recognition only after speech confirmation. Whisper results update
one provisional YOU row, without submitting it to the model. Silence remains
inside the active turn until the two-second boundary; finalization produces the
text-only request. Keep punctuation-only rejection after recognition as a
separate safeguard. A VAD-positive result does not prove meaningful words.

Mute clears queued detection/recognition and invalidates old frame results.
End terminates both workers and closes media. Bound outstanding detection to
two seconds of audio; fail visibly if inference cannot keep up or fails, rather
than silently reverting to volume-based detection or remote STT. Call Live
continues using the native provider's speech/turn handling.

## Limits and verification

VAD estimates speech presence, not speaker identity. It cannot distinguish the
user from BOT audio leaking through speakers; acoustic echo cancellation remains
separate and device dependent. Wind/noise rejection is not guaranteed.

Tests cover high-volume non-speech gating, quiet speech, pre-roll, the pause
boundary, draft isolation, mute/reset epochs, bounded queues and disposal.
Browser evidence uses the real Silero and Whisper models with controlled
recorded speech and synthetic noise; those fixtures do not prove accuracy for
every room, microphone or speaker setup.
