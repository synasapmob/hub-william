# AUDIO TO TEXT

Transcribe a recorded audio file into text with Vosk, an offline speech
recognition toolkit. Recognition runs in your browser, so the audio never
leaves your computer.

## Overview

Pick a language, choose an audio file and press **Transcribe**. The transcript
fills in while the file is processed, and can be copied or downloaded as a
`.txt` file.

## Supported input

- Any audio file your browser can play, such as `.mp3`, `.wav`, `.m4a`, `.ogg`
  or `.flac`. Support depends on the browser's own codecs.
- Files up to 50 MB. The whole recording is decoded in memory.
- Stereo recordings are mixed down to mono and resampled to 16 kHz before
  recognition.

## Languages

English (US), English (India), Vietnamese, Chinese, French, Spanish, German,
Russian, Italian, Portuguese and Turkish. Each uses Vosk's small model, between
32 and 46 MB.

## Availability

- The model for the selected language downloads the first time you use it, then
  stays in your browser's storage. Choosing another language replaces the model
  held in memory and downloads that one.
- Models are served by the vosk-browser project at
  `ccoreilly.github.io/vosk-browser/models`. If that host is unavailable the
  tool shows a load error.
- Small models trade accuracy for size. Expect mistakes with noisy audio,
  strong accents, names and technical terms, and no punctuation or capital
  letters in the output.
- There is no API or command-line equivalent; Hub William does not receive or
  store your audio.
