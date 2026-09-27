# ADR-0033: Groq API-key Chat and composed Call

- Status: Accepted
- Partially superseded by [ADR-0037](0037-browser-local-speech-recognition.md) for remote STT, audio input and the Call selector.
- Partially superseded by: ADR-0034 for silence timing, streaming and interruption.
- Date: 2026-09-27
- Partially supersedes: ADR-0032's restriction to native call transports, only for the explicitly authorized Groq pipeline.

## Context

The operator requested Groq as a separate provider from Grok, connected with a
user-supplied API key like DeepSeek. They explicitly authorized both text Chat
and a speech-to-text → language model → text-to-speech Call, using a small
current lineup available on Groq's free tier. This connection uses Groq directly;
it does not use OpenRouter or a shared application key.

## Decision

- Validate each key against Groq's authenticated `/openai/v1/models` endpoint,
  then reuse the encrypted credential envelope, masked key suffix, account
  identity, sharing, revalidation, and static-key refresh exclusions from
  DeepSeek. Never return the upstream key to the browser or installers.
- Groq is visible with an account count, including zero, in Agents, organization
  sharing, and both Playground modes. Account and model prerequisites follow the
  existing flow. Preserve Organization → Mode → Provider → Account → Model.
- Intersect live discovery with these current Chat IDs: `qwen/qwen3.8-27b`
  (Preview), `openai/gpt-oss-20b`, and `openai/gpt-oss-120b`. Omit old Llama,
  Qwen, Compound, moderation and audio models from Chat. Chat uses Groq's
  Responses SSE API without unsupported `store` or `previous_response_id`.
  Initial Groq attachments are text files; image input is outside this change.
- Call lists `whisper-large-v3-turbo` only when live discovery contains every
  pipeline dependency: Whisper turbo, `openai/gpt-oss-20b`, and
  `canopylabs/orpheus-v1-english`. Whisper itself only transcribes. The Hub
  pipeline supplies the conversation and speech output; it is not a native
  speech-to-speech or video model. Discovery does not prove a key's runtime quota
  or model permission, so upstream errors remain visible.
- The browser uses AudioWorklet at 16 kHz mono with voice activity detection,
  300 ms of speech pre-roll, an 800 ms pause, and a maximum 20-second turn.
  It sends bounded PCM16 WAV through the session-authenticated
  `POST /playground/groq/voice/turn` endpoint. The exact selected account and
  existing personal/pool/organization access checks apply to every turn.
- The API calls Groq transcription, Chat Completions, and Orpheus speech in
  sequence without retrying or changing accounts. The fixed English voice is
  `hannah`; answers are requested briefly. Longer answers are split at word
  boundaries into at most 200-character TTS inputs. Audio clips preserve their
  order and all returned text appears in the transcript.
- Bound input to 2 MiB JSON, 20 messages / 32 KiB history, and 20 seconds of
  audio. Bound output to 1,600 reply characters, 2 MiB per audio clip, and 4 MiB
  total audio. A turn has a 90-second overall deadline and one in-flight turn
  per account per API process. This process-local guard is not a distributed
  account lock. Provider 401 requires reconnect; 429 uses existing cooldown.
- Playback and listening alternate to avoid recording BOT audio. There is no
  interruption/barge-in while BOT is answering. Mute discards partial capture;
  End, abort, route/mode/account changes, and setup errors release capture,
  playback, camera and pending requests, including late permission grants.
  Camera stays local and is never sent to Groq. Browser abort cannot undo
  provider work already accepted by Groq.
- Audio and history remain in memory and are not persisted by Hub. Organization
  usage records one successful conversational turn, attributed to the chat
  model, with its actual reported text tokens. Audio durations/costs are not
  represented by the current usage schema. A bookkeeping failure after completed
  provider work is logged server-side; it does not discard the answer or replay
  paid work. Such a failure may leave usage incomplete.
- Expose Groq Chat through Hub gateway models, Responses and Chat Completions;
  OpenCode and OMP discover these models using only the Hub key. The standalone
  agent-CLI installer is unchanged because Groq is not a separate agent CLI.

## Sources checked on 2026-09-27

- [Current models](https://console.groq.com/docs/models) and
  [deprecations](https://console.groq.com/docs/deprecations): Llama 3.1/3.3 are
  enterprise-only after August 16; Qwen 3.6 was replaced by 3.8 on September 14.
- [Free-plan limits](https://console.groq.com/docs/rate-limits): current selected
  models have free-tier quotas. Free tier is limited, not unlimited usage, and
  using a paid Groq organization follows that organization's billing settings.
- [Transcription](https://console.groq.com/docs/speech-to-text) and
  [Orpheus](https://console.groq.com/docs/text-to-speech/orpheus): separate STT/TTS
  endpoints, English voices, WAV speech and a 200-character TTS input limit.
- [Responses API](https://console.groq.com/docs/responses-api) and
  [API reference](https://console.groq.com/docs/api-reference): model IDs,
  streaming contract and unsupported stateful request fields.

## Consequences

Groq Call works as a sequence of spoken turns with English replies. Latency and
free-tier TTS limits can end a call earlier than ChatGPT's native realtime flow.
This does not add camera perception or pronunciation scoring. Live account
entitlement and real microphone quality still require a connected Groq key and
browser testing; fixture tests establish transport and lifecycle behavior only.
