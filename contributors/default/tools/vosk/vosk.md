# AUDIO TO TEXT

Transcribe your voice or a recorded audio file into text with Vosk, an offline
speech recognition toolkit. Recognition runs in your browser, so the audio never
leaves your computer.

## Overview

Pick a language and an input, then press **Transcribe**. The transcript fills
in while the audio is processed, and can be copied or downloaded as a `.txt`
file.

## Input

- **Voice** records from your microphone. Press **Start recording**, speak, then
  press **Stop recording**. Your browser asks for microphone permission the
  first time; if you block it, allow the microphone for this site in the
  browser's site settings. Recording stops by itself after 10 minutes, and
  leaving the Voice tab discards an unfinished recording and turns the
  microphone off. Microphone access needs a secure page (`https://` or
  `localhost`).
- **Import** transcribes an audio file you choose.

## Supported imported files

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
