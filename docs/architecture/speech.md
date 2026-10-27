# Browser-local speech

Call Whisper, the AUDIO TO TEXT tool and call recordings run their audio work in the browser. Call Whisper listens with a voice activity detector, transcribes with Whisper, sends only text to the chat API and speaks the reply with Piper. This document describes that chain, recordings, the Vosk tool and the one server-side speech endpoint (`POST /tts`). Mode selection and what Call Whisper asks of the chat API are in [playground.md](./playground.md).

## Where things run

| Component                | Runs in                                                      | Source                                                                                      |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Microphone capture       | `AudioWorklet` (`call-capture`), 16 kHz mono, 100 ms frames  | `apps/frontend/public/audio/call-capture.js`                                                |
| Voice activity detection | Module worker, Silero VAD on ONNX Runtime (WASM, one thread) | `playground-local-vad.ts`, `playground-local-vad.worker.ts`                                 |
| Speech recognition       | Module worker, Whisper through Transformers.js               | `playground-local-stt.ts`, `playground-local-stt.worker.ts`                                 |
| Speech synthesis         | Module worker, Piper through ONNX Runtime (WASM, one thread) | `playground-local-tts.ts`, `playground-local-tts.worker.ts`                                 |
| Orchestration            | Main thread                                                  | `playground-whisper-voice.ts`, `playground-whisper-turn.ts`, `playground-speech-preload.ts` |
| Playback and recording   | Main thread, Web Audio and `MediaRecorder`                   | `playground-voice-playback.ts`, `playground-recorder.ts`                                    |

All `playground-*` files are in `apps/frontend/src/services/playground/`. The `.ts` files next to a `.worker.ts` are the main-thread clients that own the worker, its request ids, timeouts and cancellation; the model code is in the worker.

The only request a Call Whisper turn sends to the Hub API is `POST /playground/chat` with text. No audio is uploaded. VAD and TTS run on single-thread WASM, and Whisper uses WebGPU when it works and single-thread WASM otherwise, so neither WebGPU nor cross-origin isolation is required (the page works behind the staging proxy).

## Call lifecycle

### Start

`playgroundWhisperVoiceService.start` runs this sequence and reports `connecting` until it ends:

1. Require `getUserMedia`, `AudioContext` and `AudioWorkletNode`; otherwise fail with a message about browser support.
2. Create an `AudioContext` at 16 kHz and, when the call has a recorder, a `MediaStreamDestination` that receives the bot audio.
3. Load the worklet from `audio/call-capture.js`.
4. `playgroundSpeechPreload.take` claims the warmed recognizer, detector and synthesizer, or prepares them if nothing was warmed.
5. Request the microphone with echo cancellation, noise suppression and auto gain control.
6. Connect microphone → worklet → silent destination (the microphone is never played back), start the camera preview when enabled, and report `connected` with phase `listening`.

A denied microphone becomes "Allow microphone access in your browser to start a call." An ended microphone track ends the call.

### Preload and ownership

`playgroundSpeechPreload.preload` is called by the Playground workspace once the session check completes. It runs in every mode, for guests too, and starts downloading and initializing the three workers whether or not a call is ever started. It returns a release function.

- Preparation is shared and reference-counted: each `preload` adds an owner; releasing waits one microtask before aborting so React StrictMode's effect replay reuses the work instead of starting a second download.
- `take` transfers ownership to a call: the warm entry is cleared, so leaving the page cannot abort it, and the call's abort controller kills all three workers when the call ends.
- Workers are not reused across calls. The next call prepares again; cached assets make that fast, and Piper's model is re-hashed on each load.
- A failed or aborted warm entry is replaced on the next `take`. A background failure does not affect Chat; Start retries initialization and shows persistent errors.

### End and errors

`finish` aborts the call controller, disposes the recognizer, detector and synthesizer, interrupts the active turn, discards unfinished input, stops microphone, camera and recorder streams, closes the audio context and reports `ending` then `ended`. Any error in a turn (chat, synthesis, recognition, detection, over-long input or reply) calls `finish` with a message and the call ends as `failed`. There is no retry inside a call.

## Listening

### Capture and voice activity detection

The worklet posts a 1,600-sample `Float32Array` (100 ms) per frame. Frames are dropped while the call is muted or closed. The detector client sends each frame to the VAD worker, which runs Silero on 512-sample windows with 64 samples of context, carries the remainder between frames and returns the maximum probability over the windows of that frame. A frame is speech when its probability is at least `0.5` (`VOICE_SPEECH_PROBABILITY`).

- The client keeps at most 20 frames in flight (2 s of audio). If the worker falls behind, the call fails with "Voice detection cannot keep up on this device."
- `reset()` bumps an epoch, drops stale frames and zeroes Silero's state; mute uses it.
- The VAD model is the pinned `onnx-community/silero-vad` file from Hugging Face, size-capped at 8 MiB and cached in the Cache API as `hub-speech-models-v1`. It is not hash-verified. Loading times out after 60 seconds.

Why: VAD estimates speech presence, not speaker identity. It cannot tell the user from bot audio leaking through the speakers, so avoiding self-interruption depends on the browser's echo cancellation.

### Utterance state machine

`PlaygroundVoiceActivity` (`playground-voice-audio.ts`) turns frames into utterances:

| Rule                    | Value                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| Pre-roll                | The last 3 non-speech frames (300 ms) before the first speech frame are kept |
| Active                  | At least 2 speech frames have been seen in the utterance                     |
| End of utterance        | 20 consecutive non-speech frames (2 s), or 200 frames (20 s) in total        |
| Discard                 | An utterance with fewer than 2 speech frames is dropped                      |
| Audio handed to Whisper | Pre-roll, speech and the trailing silence, as one waveform                   |

When an utterance becomes active the call reserves a YOU row id; the incomplete (provisional) row appears with the first preview text. YOU and BOT rows are numbered in pairs: the YOU row has id `n` and the reply row `n + 1`.

### Previews and the final decode

While an utterance is open, a speech frame triggers a preview decode of the whole waveform so far once at least 10 frames have passed since the last preview. Only one preview runs at a time and none starts during silent pauses. The streamed partial text of a preview replaces the provisional YOU row only when it is not shorter than the current text and contains a letter or number. A preview that completes with no letter or number removes the draft.

When the utterance ends the preview is cancelled and a fresh final decode of the full waveform runs. If the final text has no letter or number the draft is deleted and the call returns to `listening`. Otherwise the row is marked complete and the turn is sent. A final transcript over 8,000 UTF-8 bytes ends the call.

### Recognition worker

| Item              | Value                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model             | `onnx-community/whisper-base`, pinned to a fixed revision, fetched by Transformers.js; browser caching on, local models off                                                 |
| Language and task | `language: "en"`, `task: "transcribe"`, no timestamps, `max_new_tokens: 256`; automatic language detection is not used                                                      |
| Input             | 160 to 320,000 samples at 16 kHz (20 s)                                                                                                                                     |
| Backend           | WebGPU when `navigator.gpu` exists and a one-token warm-up decode succeeds (encoder `fp32`, decoder `q4`); otherwise WASM with `q8`. Any WebGPU failure falls back silently |
| Partial text      | A `TextStreamer` posts partial text as it decodes                                                                                                                           |
| Concurrency       | One decode at a time; a new request replaces a pending one                                                                                                                  |
| Cancellation      | Cancelling the active request interrupts the `InterruptableStoppingCriteria` and its result is not posted; cancelling a pending one drops it                                |
| Timeouts (client) | 180 s to load, 60 s per transcription                                                                                                                                       |

Whisper's ONNX Runtime WASM files are not set by this worker (`wasmPaths` is unset), so Transformers.js's default applies and points at `cdn.jsdelivr.net`. VAD and TTS workers set `wasmPaths` to the bundled ONNX Runtime assets.

## Speaking

### Turn and segmentation

`playgroundWhisperTurnService.turn` makes one `playgroundService.chat` call with the paired history and the new transcript, then speaks while the reply streams:

- Reply text accumulates into a pending buffer. A segment ends at `.`, `!`, `?`, `。`, `！` or `？` followed by whitespace or the end of text, or at a newline.
- A segment is at most 240 characters: if no boundary falls within 240 characters, the buffer is cut at the last space at or before 240, or at 240.
- Segments with no letter or number are skipped, markdown is not stripped, and a reply over 16,000 characters fails the turn.
- Synthesis requests are chained, so segments are spoken in order. The final buffer is flushed when the stream ends. Text is shown immediately; speech trails it.
- PCM is handed to playback as it arrives and is not kept in the turn result.

### Synthesis worker

| Item              | Value                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice             | Piper `en_US-ljspeech-medium` from `diffusionstudio/piper-voices`, pinned to a commit; phonemized with eSpeak language `en`                                                                                               |
| Output            | Mono PCM at 22,050 Hz                                                                                                                                                                                                     |
| Model asset       | 63,531,379 bytes, SHA-256 verified                                                                                                                                                                                        |
| Phonemizer assets | WASM 635,212 bytes and data 18,077,249 bytes, bundled with the app and SHA-256 verified                                                                                                                                   |
| Verification      | Each asset must match its exact byte length and digest, on download and on every cache read. A corrupt cache entry is deleted and fetched again once. Cache API failure (private browsing, quota) does not stop synthesis |
| Cache             | Cache API name `hub-piper-speech-v1`; requests use `credentials: "omit"`                                                                                                                                                  |
| Phonemization     | A fresh phonemizer module per segment; the result must be 1 to 2,048 phoneme ids in the range 0 to 255                                                                                                                    |
| Inference         | One worker, one ONNX session, scales `[0.667, 1, 0.333]`; phonemization and inference stay off the main thread                                                                                                            |
| Segment limit     | Text must be non-empty and at most 240 characters                                                                                                                                                                         |
| Client checks     | Audio must be non-empty, finite, 22,050 Hz and at most 60 s; otherwise the call fails                                                                                                                                     |
| Timeouts (client) | 180 s to load, 60 s per segment; a timeout disposes the whole synthesizer                                                                                                                                                 |
| Cancellation      | A cancel drops a pending request, or marks the in-flight one so its result is discarded                                                                                                                                   |

During loading the worker phonemizes "Hello" once, so a broken phonemizer is caught during preparation without playing audio.

Persistence of Cache API writes was not reliable in one tested WebKit runtime, so the Piper assets may be downloaded again there. Speech works with a fresh download.

### Playback

`PlaygroundVoicePlayback` (one instance per turn) schedules PCM chunks on the call's `AudioContext`:

- At most 2 decoded buffers wait and 2 sources are scheduled at a time. Sources start on the audio clock at `max(currentTime + 0.02, nextStart)` so consecutive chunks join without gaps.
- Playback starts when 2 chunks are ready, when the last chunk of the reply is ready, or after 1.2 s of buffering, so a short or slow reply never waits indefinitely.
- On underrun (no source playing and nothing ready) playback goes back to buffering and reports phase `thinking`; while sources play it reports `speaking`.
- Encoded input is capped at 32 MiB and decoded audio at 64 MiB; exceeding either fails the call.
- Every source connects to the speakers and, when recording, to the recording destination.

### Barge-in

The detector keeps running while the bot speaks. When 2 consecutive frames are speech and a turn is active (recognizing, waiting for the model or speaking), `interrupt` runs:

- It aborts the turn's controller, which cancels recognition, the chat request, queued synthesis and playback in one step; stale synthesis results are discarded.
- It removes the incomplete YOU draft of that turn. A barge-in during final recognition therefore discards that utterance; one after the transcript was completed keeps the row.
- A reply cut short keeps the text already shown and appears in later history (see [playground.md](./playground.md#call-whisper)).

Mute resets the detector, discards partial input, disables the microphone track and, during final recognition, interrupts the turn.

## Recordings

Recording is opt-in: the Record button works only during a connected call, in Call Live and Call Whisper. Nothing is uploaded.

| Item       | Value                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video      | A 1,280 by 720 canvas captured at 24 fps. The camera frame is mirrored and letterboxed; with no camera the canvas shows "Camera is off"                               |
| Audio      | Microphone and bot audio mixed in a separate `AudioContext`; the microphone is never routed to the speakers                                                           |
| Format     | The first supported of `video/webm;codecs=vp8,opus`, `video/webm`, `video/mp4`; 1.5 Mbps video, 128 kbps audio                                                        |
| Limit      | Recording stops and saves at 128 MiB and is marked as stopped at the limit                                                                                            |
| Transcript | Every row except those already complete when recording started                                                                                                        |
| Storage    | IndexedDB database `hub.playground.recordings` (version 1) with stores `recordings` (metadata and transcript) and `files` (the `Blob`), both keyed by `[ownerId, id]` |
| Failure    | If saving fails, the unsaved recording stays downloadable; a `beforeunload` warning is active while recording, saving or unsaved                                      |
| Download   | `hub-call-<timestamp>.webm` or `.mp4`, and `hub-call-<timestamp>.txt` for the transcript                                                                              |

Ending the call stops an active recording first.

## AUDIO TO TEXT (Vosk)

The AUDIO TO TEXT tool (`services/vosk/` and the Vosk page under `routes/_app.tools.($contributor)/`) transcribes an audio file or a microphone clip entirely in the browser. It is separate from the Playground chain.

- **Models:** 11 small Vosk models (English US and India, Vietnamese, Chinese, French, Spanish, German, Russian, Italian, Portuguese, Turkish) listed in `vosk-models.ts`, downloaded as `.tar.gz` from `https://ccoreilly.github.io/vosk-browser/models`. `vosk-browser` performs the download and keeps the extracted model in IndexedDB; nothing in the app verifies a hash.
- **Runtime:** `vosk-browser` is imported on demand. Only one model stays loaded; choosing another terminates the previous worker. The service constructs `Model` directly and listens for `load` and `error`, because `createModel()` never rejects.
- **Input:** a file up to 50 MB, decoded with an `OfflineAudioContext` to 16 kHz mono (channels averaged), or a recording of up to 10 minutes with `MediaRecorder` (WebM/Opus, Ogg or MP4, whichever the browser supports). A recording is transcribed after it ends, not live, and stays in memory.
- **Recognition:** samples go to the recognizer in 2-second chunks; progress counts worker replies, and the result is complete after one reply per chunk plus the final result.

## TEXT TO AUDIO (`POST /tts`)

The TEXT TO AUDIO tool is the only server-side speech endpoint. It is public, limited to 30 requests per minute per IP, and returns `audio/mpeg` with `Cache-Control: no-cache`.

- Body: `text` (required, non-empty), `voice` (default `en-US-AriaNeural`), `rate` (default `0%`) and `pitch` (default `0Hz`).
- `apps/api/src/utils/tts/mod.rs` opens a WebSocket to the Microsoft Edge speech service, requests `audio-24khz-48kbitrate-mono-mp3` and collects the audio. A provider error is retried after 500 ms, 1.5 s and 3 s before the request fails.
- The frontend caller is `tools-catalog-edge-tts.tsx`; the Playground does not use this endpoint.

## Network dependencies

| Host                  | What                                                                                                        | Used by       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ------------- |
| Hugging Face          | Whisper base weights (`onnx-community/whisper-base`), Silero VAD model, Piper voice model                   | Call Whisper  |
| `cdn.jsdelivr.net`    | ONNX Runtime WASM for Whisper, by Transformers.js default (the worker does not override it)                 | Call Whisper  |
| `ccoreilly.github.io` | Vosk model archives                                                                                         | AUDIO TO TEXT |
| Hub origin            | Worklet, ONNX Runtime assets for VAD and TTS, Piper phonemizer assets, `POST /playground/chat`, `POST /tts` | All           |
