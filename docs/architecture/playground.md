# Playground

The Playground (`/playground`) is a session-backed page for talking to a connected provider account in one of three modes: Chat, Call Live and Call Whisper. The browser never receives provider credentials and never creates a gateway key; every request goes through the Hub API with the session cookie. The browser-local audio chain used by Call Whisper is described in [speech.md](./speech.md).

## Where the code lives

| Concern                                      | Path                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Route, form defaults, URL seeds, remount key | `apps/frontend/src/routes/_app.playground/route.tsx`                                              |
| Setup, eligibility, Chat, mode switching     | `apps/frontend/src/routes/_app.playground/playground-workspace.tsx`                               |
| Call panel (Start, End, Mute, camera, Zoom)  | `apps/frontend/src/routes/_app.playground/playground-voice.tsx`                                   |
| Markdown rendering                           | `apps/frontend/src/routes/_app.playground/playground-response.tsx`                                |
| API client (models, chat, voice session)     | `apps/frontend/src/services/playground/playground-service.ts`                                     |
| Mode and provider eligibility                | `apps/frontend/src/services/provider-catalogue/provider-catalogue-service.ts`                     |
| Call Live client                             | `apps/frontend/src/services/playground/playground-voice.ts`                                       |
| Call Whisper client                          | `apps/frontend/src/services/playground/playground-whisper-voice.ts`, `playground-whisper-turn.ts` |
| Saved mode and media preferences             | `apps/frontend/src/utils/utils.playground-media.ts`                                               |
| Playground API (models, chat, voice)         | `apps/api/src/api/playground/`                                                                    |
| Codex voice session creation                 | `apps/api/src/api/gateway/voice.rs`                                                               |

## Setup

### Order and scope

Setup lists Organization, Mode, Provider, Account and Model, in that order. Each control depends on the ones above it.

- **Personal scope** (no organization selected): the accounts of the signed-in user's own pools plus pools they have joined. The frontend takes them from `GET /agent-pools` and keeps those whose access is `owner` or `joined`. The API resolves the same set when it selects candidates.
- **Organization scope** (an organization selected): agents shared with that organization. The frontend loads them with the organizations service; the API requires both the caller and the account's sharer to be accepted members. Personal pools never mix into an organization request, and organization agents never mix into a personal one.
- **Guests** see no accounts. Provider shows "No providers available", and Account and Model show "Sign in to continue".

The route seeds the form from the URL: `?organization=`, `?connection=` and `?provider=` (default `chatgpt`). The saved mode is read from `localStorage` on mount.

The workspace is keyed by `userId:organizationId`. Changing the signed-in user or the organization remounts it, which clears the conversation, ends any call and resets Zoom.

### Provider, account and model selection

- **Provider list:** a provider appears only if it supports the selected mode (`providerCatalogueService.supportsMode`) and the scope holds at least one accessible account of it. A provider with zero accounts is never listed. Changing the mode keeps the provider when it still qualifies, otherwise it switches to the first provider that does. It always clears the model; the account is cleared only when the provider changes.
- **Account:** the form's `connectionId` if it is still in the list, otherwise the first account that does not need reauthorization, otherwise the first account. Changing the provider clears the account and the model.
- **Reconnect states:** an account with availability `reauth_required` needs its owner to reconnect it. If another account of that provider in the scope is usable, Setup shows a note that messages use another account and everything stays enabled. Only when every account of that provider in the scope needs reconnect does the model query turn off, the Model list empty and Send and Start stay blocked. For personal pools, a Google verification link (`validationUrl`) is offered when the API reports one.
- **Model query:** `GET /playground/{provider}/accounts/{connection_id}/models`, with `?organization_id=` for an organization. It needs the session cookie only. The query runs when there is a user, an account, no blocking reconnect state and, for an organization, a loaded organization.

### Model discovery (API)

`models` in `apps/api/src/api/playground/mod.rs` asks the gateway for the account's live model list (personal or organization variant), then:

1. Normalizes the entries into `{ id, name, modes, capabilities, call? }` with `modes` containing `chat`.
2. Keeps only current models. ChatGPT and Claude (`discovery.strategy = official_docs`) are intersected with the provider's official model list, which the gateway caches for one hour. Other providers use the catalogue's current chat models (`current_chat_model`).
3. For every call profile of the provider whose availability rule passes, adds the `voice` mode to the model matching the profile's `selector_model`, or appends a voice-only entry carrying the profile's name. For ChatGPT this yields `Codex Voice` (`gpt-live-1-codex`) whenever the account has at least one current chat model.

The wire value `voice` therefore means "this entry can run a call profile". Entitlement to the Codex realtime endpoint is only tested when the session is created.

The frontend (`playgroundService.models`) validates the response and drops a `call` profile it does not recognize instead of rejecting the list, so a model stays available for Chat and Call Whisper while the frontend and API are deployed at different times.

### Refetch policy

Setup queries (`setupQueryOptions`) do not refetch on window focus or network reconnect. The shell's organization navigation and invitation bell also skip those refetches while the Playground is open. Page entry, a changed account or organization, explicit retries and account-management invalidations still fetch current data. Stopping a request, or finishing one on the selected account, never invalidates pools or models. A failed Chat turn, or one answered by another account, invalidates only the current scope's account list so Setup statuses stay current; the selection does not change.

## Modes

|                     | Chat                                                                                      | Call Live                                                                                                                                                  | Call Whisper                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Providers listed    | Every provider with the `chat` capability (ChatGPT, Claude, Gemini, Grok, DeepSeek, Groq) | Providers with a `native_realtime` call profile: ChatGPT only                                                                                              | Every provider with the `chat` capability                                                  |
| Models listed       | Entries whose `modes` include `chat`, shown by name                                       | Entries whose `modes` include `voice` and whose call profile matches the provider, the entry id and `callMode(profile) === "call-live"`, shown by exact id | Entries whose `modes` include `chat`, shown by exact id                                    |
| Transport           | `POST /playground/chat`, text event stream                                                | WebRTC to the Codex realtime endpoint; SDP offer through `POST /playground/voice`                                                                          | Audio stays in the browser; each turn sends text through `POST /playground/chat`           |
| Start or Send needs | Signed in, an account, a model with chat support                                          | An account and a model; browser with `getUserMedia` and `RTCPeerConnection`                                                                                | An account and a model; browser with `getUserMedia`, `AudioContext` and `AudioWorkletNode` |
| Conversation state  | Mounted page only; nothing persisted                                                      | Transcripts from the data channel                                                                                                                          | Transcripts built locally                                                                  |

Eligibility lives in `supportsMode`: Chat and Call Whisper need the provider's `chat` capability; Call Live needs a call profile whose kind maps to `call-live`. The catalogue's call profile of kind `native_realtime` (transport `codex_v3_webrtc`) is ChatGPT's. See [provider-catalogue.md](../provider-catalogue.md) and [gateway.md](./gateway.md).

### No fallback between modes

A mode never falls back to another mode. If the selected provider has no model for the selected call mode, the Model select lists nothing ("No call models available"), Start stays disabled and nothing switches the user to a different mode. In Call Live the Provider select lists only providers with a `native_realtime` profile and an accessible account; with none it reads "No providers available" and is disabled.

The only automatic change of mode is a `localStorage` migration. A saved `hub.playground.mode` of `voice` is read as a request for a call mode. After accounts finish loading, the workspace resolves it to `call-live` when the chosen provider has a `native_realtime` profile and to `call-whisper` otherwise, writes the resolved mode back and from then on behaves as that mode. The provider used for the decision is the requested one if it has an accessible account, else the first accessible provider. With no accessible provider (a guest, or no accounts) the page shows Call Live and leaves the saved `voice` value in `localStorage` until a provider exists.

Why: only the Codex V3 WebRTC protocol was verified live for native voice, so Call Live is ChatGPT-only. See [ADR-0002](../decisions/0002-playground-native-voice.md).

### Changing mode

The Mode select is the only Setup control that stays enabled during a call. Choosing another mode unmounts the call panel, whose cleanup aborts the call and ends it; the panel is keyed by `mode:connectionId:model`. The account selection and the Chat draft are kept. Starting a call is always an explicit click, and restoring a saved mode never starts media.

## Chat

`POST /playground/chat` streams a provider-native text event stream that the browser parses per provider (`playground-stream.ts`).

### Client rules

- Send is available in Chat mode only. A guest's Send opens the sign-in dialog. Send needs an account and a model that supports chat, and is blocked while a file is being read or a request is in flight.
- Images are blocked when the selected model lacks the `image_input` capability. This also applies to images already in the completed history, so the user is asked to start a new conversation or pick an image-capable provider.
- **History** sent with each request is the complete turns only: question, attachments and answer. Stopped, failed and incomplete answers stay visible but never enter later requests.
- **Stop** aborts the request, marks the turn `interrupted` and restores the prompt and attachments to the form. A failed turn shows the error, and the current scope's account list is refetched.
- **Attachments:** up to 4 files per message, 5 MiB each. The browser reads images (PNG, JPEG, GIF, WebP) as base64, reads text files as text and extracts PDF text with `pdfjs-dist`; a PDF becomes a text attachment.
- The API names the answering account in the `x-hub-connection-id` response header. The turn shows it when it differs from the selected account.
- A `401` with code `unauthorized` triggers one `POST /auth/refresh` and one replay, only before any upstream work or streaming begins. If the session is gone, Chat opens the sign-in dialog.

### API rules (`apps/api/src/api/playground/`)

| Rule              | Value                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication    | Session cookie, resolved by `authorize_chat` before the body is buffered                                                             |
| Origin            | The `Origin` header must be in the browser origin allow-list, otherwise `403`                                                        |
| Body size         | 32 MiB for the route group (nginx mirrors it for `/api/playground/chat`)                                                             |
| Rate limit        | 30 requests per minute per user, shared by chat and voice                                                                            |
| Messages          | Alternating `user` / `assistant`, ending with `user`; a message needs text or attachments; assistant messages carry no attachments   |
| Attachments       | At most 4 per message; 5 MiB each; images must be PNG, JPEG, GIF or WebP with matching magic bytes                                   |
| Images            | Accepted only for providers with the `image_input` chat capability: ChatGPT, Claude and Gemini. Grok, DeepSeek and Groq return `422` |
| Model id          | Non-empty and without `/` or `:`; for Groq it must be a current catalogue model                                                      |
| Voice-only models | A call-profile model without the `chat` capability (`gpt-live-1-codex`) is refused: "Select Call to use this voice model."           |

Text attachments reach the prompt as `Attached file: {name}` followed by the content. The request body depends on the provider:

| Provider                | Body sent to the gateway                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT, Grok, DeepSeek | Responses-style `input` with `stream: true`, `store: false` and the instruction "Answer the user's questions helpfully."                 |
| Groq                    | Same, without `store`                                                                                                                    |
| Claude                  | Messages with `stream: true` and `max_tokens: 4096`; reaching the limit fails the turn with an error, and the partial text stays visible |
| Gemini                  | `contents` with `user` and `model` roles and `inlineData` for images                                                                     |

`chat` hands the body to the in-process gateway (`response_for_user` or `response_for_organization_user`). The chosen account is tried first; when it is rate-limited, needs reauthorization or is refused before streaming starts, the gateway tries another account of the same provider in the same scope. See [gateway.md](./gateway.md) for candidate order and retry rules.

## Call Live

Call Live is native speech-to-speech with ChatGPT's Codex realtime model `gpt-live-1-codex`, over WebRTC. Audio flows directly between the browser and the provider; the Hub API only exchanges the session description.

1. `playground-voice.ts` checks that the call profile has kind `native_realtime`, transport `codex_v3_webrtc`, and matches the provider and model.
2. The browser creates an `RTCPeerConnection` and a data channel named `oai-events`, adds the microphone track (echo cancellation, noise suppression and auto gain on) and creates an offer. It waits for ICE gathering to complete, for at most 3 seconds.
3. The browser sends the offer to `POST /playground/voice` (session cookie, Origin check, 96 KiB body limit). The API accepts only ChatGPT with `gpt-live-1-codex` and an SDP of at most 64 KiB that starts with `v=0`, has an `m=audio` line and no `m=video` line. It adds fixed instructions, the voice `cove` and `delegation: client`.
4. `create_voice_session_for_user` walks the scope's ChatGPT candidates. For each account it posts the offer to the Codex realtime calls endpoint with header `openai-alpha: quicksilver=v2`, a 35 second timeout and a 128 KiB cap on the answer. The answer must start with `v=0` and contain an `m=audio` line.
5. Session creation is not idempotent and is never replayed. A rate limit, a need to reauthorize, or an explicit refusal moves on to the next account; a transport error or an unreadable answer returns an error at once without trying another. If no account starts the call, the result is `429` when at least one account was rate-limited, else a "reconnect this account" error when one needed reauthorization, else the last provider error. The provider's refusal reaches the user as `This account could not start a voice call (provider HTTP <status>).`; a Free-plan ChatGPT account was observed to get `404` there (see [ADR-0002](../decisions/0002-playground-native-voice.md)).
6. A successful setup marks the account active and records one organization usage event when the request is organization-scoped; token counts stay unknown because media and events travel over WebRTC.
7. The browser applies the answer and waits for the data channel to open. A 50-second timer starts when the call starts, so it also covers the permission prompt, ICE gathering and the `POST /playground/voice` round trip; if the data channel has not opened by then, the call fails. A closed channel, a failed or disconnected peer connection or an ended microphone fails the call; there is no automatic reconnect.

Transcripts come from the data channel (`turn.done` and delta events, parsed in `playground-voice-events.ts`). A `delegation.created` event is treated as an error because the session offers no tools.

The camera is a local `<video>` preview only. Camera tracks are never added to the peer connection, and a denied or ended camera does not end the call.

## Call Whisper

Call Whisper runs speech recognition and speech output in the browser and uses the ordinary chat API for the model. The chain is in [speech.md](./speech.md); what it asks of Chat is:

- **One request per spoken turn:** `playgroundService.chat` with no attachments, built by the same API code as Chat, so every provider with chat capability works and the account fallback of Chat applies.
- **History:** pairs of a completed YOU row and a BOT row that has text. A BOT row cut short by an interruption is included with the text the user saw. At most 20 messages and 32,000 bytes (the oldest pair is dropped first).
- **Transcript cap:** a recognized transcript over 8,000 UTF-8 bytes ends the call.
- **Reply cap:** a streamed reply over 16,000 characters fails the turn.
- **Speech segments:** the reply is split into segments of at most 240 characters before synthesis.
- A failure in any step (microphone, recognition, chat, synthesis) ends the call as failed; there is no retry inside a call.

## Start, End and call controls

- **Start** is enabled when accounts and models have finished loading, there is no setup error, an account and a model are selected, no start is pending and no call is active.
- The call panel renders in both call modes with the status "Ready to talk" before a call starts, including for guests, so the Start button is the gate.
- **End** aborts the request and the call, stops the microphone, camera and workers owned by the call, and stops any recording first.
- **Mute** disables the microphone track; in Call Whisper it also resets voice detection and discards partial input.
- **Recording** (Record button during a connected call) works in both call modes and is stored on the device. See [speech.md](./speech.md#recordings).

## Preferences

| Key                    | Value                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `hub.playground.mode`  | `chat`, `call-live`, `call-whisper` or `voice` (resolved to a call mode after accounts load); defaults to `chat` |
| `hub.playground.media` | `{ voice, camera }` booleans, both default `true`; applied at Start                                              |

Reads and writes are wrapped in `try`/`catch`, so the page works when storage is unavailable.

## Zoom Screen

Zoom turns the container that holds Setup and the conversation (`PlaygroundConversation`) into a fixed, full-viewport layer with Setup above the conversation and vertical scrolling inside it. Nothing remounts, so a Chat draft or a running call continues. State is a `useState` in the workspace and resets on reload. While zoomed, the container's sibling elements up to `<body>` are made `inert`, body scrolling is locked and focus returns to the element that was focused before Zoom on exit. Escape exits Zoom unless a dialog, listbox or popper is open, which handles Escape first (the handler runs in the capture phase to see those portals). Setup keeps its in-call restrictions while zoomed.

## Response rendering

While an answer is streaming it renders as plain text; Markdown, SVG and link handling apply once the turn ends. Answers then render with `react-markdown` and `remark-gfm`; no raw-HTML plugin is configured. Links open in a new tab with `rel="noopener noreferrer"`. Remote images are not loaded: an image node renders as `[Image: alt]`. After streaming ends, a fenced or line-start `<svg>` block is sanitized with DOMPurify (scripts, styles, links, images, animations and `foreignObject` are forbidden), must parse as SVG and be at most 256 KiB, and is shown as an image from a data URL with its source in a `<details>` element; anything else stays a code block.

## API surface

| Method and path                                              | Purpose                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `GET /playground/{provider}/accounts/{connection_id}/models` | Model discovery for one account, optionally scoped by `organization_id` |
| `POST /playground/chat`                                      | Streaming text for Chat and for every Call Whisper turn                 |
| `POST /playground/voice`                                     | Codex realtime SDP exchange for Call Live                               |

The two `POST` routes share the session, Origin and 30 per minute checks described above.
