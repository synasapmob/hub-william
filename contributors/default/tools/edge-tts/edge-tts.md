# TEXT TO AUDIO

Convert text into high-quality spoken audio using Microsoft Edge Neural voices.
Supports customizable reading speed, pitch adjustment, and a wide range of
international languages and regional accents.

## Overview

Edge TTS uses neural speech synthesis models without requiring cloud account keys
or per-character API quotas. It produces clean, natural-sounding `.mp3` files
suitable for language learning, study material, listening tests, and voiceovers.

## API Usage for Agents and Scripts

You can generate `.mp3` audio programmatically without opening the browser UI.

### Endpoint

- **Path:** `POST /api/tts` (or `POST /tts` on the raw API)
- **Headers:** `Content-Type: application/json`

### Request Parameters

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `text` | string | **Yes** | — | The plain text to convert into speech. |
| `voice` | string | No | `"en-US-AriaNeural"` | Azure Neural voice identifier. |
| `rate` | string | No | `"0%"` | Speed adjustment, e.g. `"-10%"`, `"+15%"`. |
| `pitch` | string | No | `"0Hz"` | Voice pitch adjustment, e.g. `"-5Hz"`, `"+5Hz"`. |

### Response

- **Status:** `200 OK`
- **Content-Type:** `audio/mpeg`
- **Body:** Binary audio stream/buffer. Save directly as an `.mp3` file.

### cURL Example

```sh
curl -X POST 'https://hub-william.site/api/tts' \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "The bus stop is located next to the main metro entrance.",
    "voice": "en-GB-SoniaNeural",
    "rate": "0%",
    "pitch": "0Hz"
  }' \
  -o speech.mp3
```

### TypeScript / Node.js Script Example

```ts
import { writeFile } from "node:fs/promises";

async function generateSpeech(text: string, voice = "en-US-AriaNeural", outputPath = "speech.mp3") {
  const response = await fetch("https://hub-william.site/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });

  if (!response.ok) {
    throw new Error(`TTS failed with HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await writeFile(outputPath, Buffer.from(arrayBuffer));
}
```

## Voice and Accent reference

Edge TTS leverages Microsoft's Neural voice engine. When updating or adding new
languages and regional accents, look up the official voice identifiers and
locale specifications in Microsoft's documentation:

- **Official Microsoft Azure Voice Directory:**
  [Language and voice support for the Speech service](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)

Voice IDs follow standard Azure neural naming conventions formatted as
`{locale}-{Name}Neural` (for example: `en-US-AriaNeural`, `ko-KR-SunHiNeural`,
`ja-JP-NanamiNeural`, `fr-FR-DeniseNeural`).
