# ADR-0049: Browser-local Vosk audio to text

- Status: Accepted
- Date: 2026-10-19
- Authority: operator requested a Vosk audio-to-text tool on the Tools page, laid out like TEXT TO AUDIO.
- Relates to: [ADR-0037](0037-browser-local-speech-recognition.md), which also keeps recognition in the browser. This tool is separate from the Playground Call and does not change it.

## Decision

Add an AUDIO TO TEXT tool (`contributors/default/tools/vosk`) that transcribes a
microphone recording or an imported audio file with Vosk in the browser, using `vosk-browser` 0.0.8
(Apache-2.0). It runs the Vosk WASM build in a Web Worker and uploads nothing.
There is no backend route, so unlike TEXT TO AUDIO it has no API or curl usage.

The frontend service `services/vosk` owns model loading and recognition. The
component calls it through a TanStack `useMutation`. `vosk-browser` is imported
dynamically because its inlined worker is about 5 MB.

Audio is decoded with an `OfflineAudioContext` at 16 kHz, mixed to mono and sent
to the recognizer in two-second chunks. The worker answers each chunk and the
final-result request exactly once and in order, so the service counts replies to
know when recognition is complete and reports progress from them. Files over
50 MB are rejected because the full waveform is held in memory.

The input is chosen with a Voice | Import switch. Voice records the microphone
with `MediaRecorder` (webm/opus, ogg or mp4, whichever the browser supports) and
produces a `File` that goes through the same decode and recognition path as an
import. It is record-then-transcribe, not live dictation. Recording stops after
10 minutes, and leaving the Voice tab cancels it and releases the microphone.
The clip stays in memory and is not stored.

Models are the small `.tar.gz` Vosk models published by the vosk-browser project
at `https://ccoreilly.github.io/vosk-browser/models`, the only host found that
serves them with CORS enabled. vosk-browser stores the extracted model in
IndexedDB, so each language downloads once. Only one model stays loaded; selecting
another terminates the previous worker.

`vosk-browser`'s `createModel()` never rejects when a download fails, so the
service constructs `Model` directly and listens for both `load` and `error`.

## Consequences

- First use of a language downloads 32–46 MB from a third-party host. If that
  host moves or removes a file, the tool fails with a load error until the URLs
  in `services/vosk/vosk-models.ts` are updated. The files are not
  hash-verified, because vosk-browser performs the download itself.
- Small models are less accurate than Whisper and output lowercase text without
  punctuation. The Playground keeps its Whisper stack unchanged.
- `vosk-browser` was last published in 2022 and bundles an older Vosk build.
- There is no cancel control for transcription. A long file runs to completion.
- Voice is record-then-transcribe, not live dictation, so nothing appears until
  the reader stops recording and presses Transcribe.

## Verification boundaries

Unit tests cover audio mixing and chunking, the reply-counting completion logic,
load failure handling, model reuse, the recorder (formats, cancel, time limit,
permission errors) and the component's states. They use a fake recognizer and a
fake `MediaRecorder`. Recognition was checked in a real browser against
synthesized speech: an imported mp3, and the microphone path using Chromium's
fake capture device playing that speech. A real microphone, the permission
prompt and other browsers (notably Safari's mp4 recording) were not exercised,
and accuracy is not established for other speakers, accents or recordings.
