# Architecture

Hub William has a React Router frontend and a Rust business API with an
in-process streaming gateway. The app exposes Home, Tools, Agents, Organization
and a model Playground. Libraries, Activities and the Documents/MCP machine
installer are retired; see [ADR-0024](../../../docs/decisions/0024-tools-agents-playground.md)
and [ADR-0027](../../../docs/decisions/0027-organizations-and-session-agent-access.md).

## Frontend routes

- `/` remains the Home white paper about tool contributions, sharing agent
  pools with teammates, and keeping provider credentials on the server. The
  retired Documents setup section is removed.
- `/tools` shows shared tools, currently Gateway, OpenCode, OMP and DOWNLOAD REEL. The existing
  contributor selector and `/tools/<contributor>` show contributed tools.
  Search checks tool metadata and
  documentation filenames. Selecting a tool sets `?node=` and opens a sheet
  containing instructions, original source downloads and a generated ZIP.
- `/agents` groups connected accounts by provider. The viewport-height shell
  keeps Connect Agent and Gateway Key visible, and the provider column stays
  sticky inside the scrollable explorer. Account rows show member avatars;
  hovering shows usage and reset information for ChatGPT/Codex and Claude.
  Grok, DeepSeek and Gemini/AGY omit the usage tooltip and the usage section in
  account details, including unavailable placeholders. Missing/unsupported usage
  for these providers does not create a warning, red border or owner error
  tooltip. Actual connection availability still controls status and warnings.
  Account details open in a modal, while diagnostic text and
  refresh/delete controls live in the owner's Manage pool access dialog.
- `/playground` supports real streaming conversations with text and attachments through the Rust gateway.
  Existing browser sessions authorize account-scoped model discovery and
  streaming requests. Personal mode uses owned or approved pools; organization
  mode uses agents shared with an accepted organization member. The browser
  never receives provider credentials or creates a gateway key. Conversation
  text stays in the mounted page; stopped and incomplete answers remain visible
  but do not enter follow-up context. Provider selection is public; account selection
  requires sign-in. Requests prefer the chosen account: when it is cooling
  down, needs reconnect or is refused before streaming starts, the API uses
  another account of the same provider in the same scope (Personal, or only
  that organization's agents). A Chat response names the account that answered
  in the `x-hub-connection-id` header, which the turn shows when it differs.
  Model, Send and Start are blocked only when every account of that provider
  in the scope needs reconnect. Images use
  native provider blocks; text files and extracted PDF text join the prompt. See [ADR-0025](../../../docs/decisions/0025-session-backed-playground.md).
  Setup queries stay stable during chat/call: completing or stopping a request
  does not invalidate pools or models. A failed Chat turn, or one answered by
  another account, refetches only the current scope's account list so Setup
  statuses stay current; the selection does not change. Playground disables tab-focus
  and network-reconnect refetches, including the shared organization navigation
  and invitation bell observers while this page is open. Page entry, changed account/context,
  explicit retries and account-management invalidation still fetch current
  data. The backend/provider remains authoritative for request access and
  availability errors; stale selections do not bypass those checks.
  Setup orders Organization, Mode, Provider, Account and Model. Modes are Chat,
  Call Live and Call Whisper. Chat lists chat-capable models; Call Live filters
  catalogue profiles with `native_realtime` (currently ChatGPT/Codex), while
  Call Whisper uses every provider with chat capability and the selected account's
  API-advertised chat models. Each mode lists only providers with at least one
  accessible account. Call Live models must also be advertised as `voice` by
  that account's API discovery; catalogue metadata alone does not grant access. Account selection keeps its
  existing access rules; Account and Model display "Sign in to continue"
  when no account is available. Call displays exact model IDs, renders "Ready to
  talk" before account selection, and waits for account/model readiness before
  allowing Start. Call Live uses the API's `voice` mode; Call Whisper sends text through Chat. `gpt-live-1-codex`
  exchanges a session-authorized audio SDP through the API and then uses native
  WebRTC for speech and two-sided transcripts. The video-style layout contains
  a local-only camera preview. See [ADR-0032](../../../docs/decisions/0032-playground-native-voice.md).
- `/organization` shows the signed-in user's default organization: team totals,
  daily requests and shared agents. There is no switcher in the header; **My
  organizations**, beside New organization, opens a dialog that lists every
  joined organization with its owner, agents, members, 30-day tokens and
  creation date from one `GET /organization-summaries` request, made only while
  the dialog is open. Choosing a row makes it the user's default with
  `PUT /organizations/{id}/default`, so it follows them to every browser;
  creating an organization or accepting an invitation makes it the default too,
  and until there is one the oldest organization is shown. Remove asks an owner
  to delete the organization for everyone and a member to leave it, then calls
  `DELETE /organizations/{id}` or `DELETE /organizations/{id}/membership`. Pending invitations are accepted or
  declined in the same dialog, and its button shows their count. The dialog is
  open while `?tab=my-organization` is in the URL, and an invitation bell beside
  Log out in the sidebar links there. The header names the default organization
  in a Badge beside 36px buttons. See
  [ADR-0046](../../../docs/decisions/0046-my-organizations-dialog-and-organization-removal.md)
  and [ADR-0047](../../../docs/decisions/0047-server-side-default-organization-and-summaries.md).
  Creation accepts an optional description of up to 350 characters. `/organization/agents` lets any accepted
  member or owner share their own existing or newly connected account through
  Connect Agent; all accepted members can use it, and the sharer or owner can
  remove it. An organization agent is a link to the sharer's Workspace
  connection, not a copy: refreshing or reconnecting it (in Workspace, or with
  Refresh by its owner here) updates it everywhere, deleting it in Workspace
  removes it from every organization, and Remove from organization keeps the
  Workspace account connected. Sharing an already shared account succeeds
  without a duplicate. The page also shows available agents;
  `/organization/members` lets the owner invite and remove users;
  `/organization/usage` filters request and reported token totals by period,
  member, agent and model. The API checks accepted membership for every view.

Pages load through skeletons. Each one renders its shape from the first paint,
through the session check, the organization list and its own queries, with
static text real and only values, lists and charts as placeholders. Organization
pages receive a `null` organization until it is known. Nothing shows "Loading…"
text, or an empty-state message, for data still in flight.

Removed pages have no route modules or dedicated redirect handlers. The existing
generic catch-all returns unknown URLs to Home.

The frontend is a prerendered SPA. Tools is static; account/session data uses
TanStack Query and the Rust API. Route-only tool components live beside their
route under `src/routes/_app.tools.($contributor)/`.

## Static tool documentation

`src/services/catalog/` reads `contributors/*/tools/` using eager raw imports.
Gateway, OpenCode, OMP and DOWNLOAD REEL keep their presentation and ordering; new tool
folders remain discoverable with a derived label. File titles and descriptions come from their
existing Markdown; the service does not rewrite sources or render Markdown as
HTML.

The build plugin publishes tool directories as original files under
`/catalog/contributors/<owner>/tools/`, tool ZIPs under
`/catalog/collections/<owner>/tools/`, and `/catalog/index.json`. Archives retain
repository-relative paths and deterministic timestamps. Development workflow
sources in `contributors/*/libraries/` are neither bundled into the frontend
nor emitted as downloadable catalogue artifacts.

Library taxonomies, the retired installer/MCP tool sources, MCP registry
discovery and whole-repository catalogue archives are removed. Tool contribution
and per-contributor catalogues retain their existing workflow.

Tool contributors create or update their own GitHub-username folder. The
`contributors/default/` namespace is system-owned and read-only for contributors;
the Home contribution guide shows this boundary in its directory tree.

## Runtime data and ownership

`apps/api` owns authentication, rotating PostgreSQL sessions, encrypted provider
connections, pool membership and join decisions, organization membership and
agent shares, and user-scoped gateway keys.
Public pool discovery contains no provider credentials. Membership and owner
operations are authenticated by the API.

An accepted member uses their own Hub key through an owner's shared provider
without receiving the provider token. Pool availability and provider quota are
reported by the backend; the frontend does not fabricate usage. Known zero
quota is displayed as Exhausted. Owner connection details are queried only
when management is open, and refresh/reconnect success updates the query cache.

Organization usage records successful generation responses selected through an
organization and keeps unknown provider token counts distinct from zero. Input
tokens include any reported cached input. Existing personal gateway keys retain
their existing reach while organization gateway-key scope awaits a separate
operator decision.

The gateway remains `apps/api/src/gateway.rs`. Extraction into a separate
service requires an explicit internal contract and must avoid an additional
API-to-gateway hop for each prompt. The Telegram application is a separate
adapter that calls the business API.

## Standalone installers

The frontend also serves `download-reel.sh`, a standalone Bash/Python video
downloader linked from DOWNLOAD REEL. It accepts `--platform=tiktok|facebook`,
`--url=VIDEO_URL` and an optional `--output-dir`. The Tools commands pipe curl
directly into Bash with the platform and URL options. Omitting the URL prompts
through the controlling terminal; positional URLs remain supported. Downloads run on the user's
computer using yt-dlp, with a public-embed fallback for Facebook. It selects
combined video/audio formats, preserves existing files and does not read browser
cookies. No media download API or server-side video storage is introduced.

The frontend serves `gateway.py`, `opencode.py` and `omp.py` from `public/`.
These scripts are independent of the retired Documents installer and use
Python's standard library. They configure local agents with a revocable Hub key;
upstream provider credentials remain encrypted on the server. OpenCode and OMP
discover current models through the gateway.

`apps/frontend/scripts/installers/tests/` verifies supported configuration
writes, model discovery, key/URL handling and the Nginx gateway proxy contract.
CI runs these checks. `install.py`, `install.sh`, the machine runtime and its
product-specific tests are removed. Repository harness/skill/hook/template
sources remain development infrastructure.

## Deployment and local development

Railway's public Nginx frontend serves static assets and proxies `/api` to the
private Rust API. The production frontend image builds with
`VITE_API_BASE_URL=/api`.

For local frontend development, `VITE_API_BASE_URL` in `.env` selects the API.
A local backend normally uses `http://localhost:8080`; a direct production URL
requires compatible CORS and session-cookie policy. Test configuration fixes
its mocked API base independently of developer `.env` settings.

Railway is the deployment target for the frontend, API and Telegram adapter.
GitHub Pages and Vercel publishing are retired. `main` remains protected by the
repository's branch and CI policies; see [ADR-0026](../../../docs/decisions/0026-railway-only-deployment.md).

All six existing Playground providers support Call Whisper through their
account-scoped chat API. Groq connects with a personal API key as before and no
longer requires Orpheus for this UI. Native Call Live remains separate.
`playground-whisper-voice.ts` owns microphone/camera capture, VAD-gated Whisper
recognition, provisional YOU rows, two-second silence and interruption.
`playground-whisper-turn.ts` sends only finalized text and paired conversation
history through the selected provider/account/organization, streams BOT text,
and queues bounded text segments for local TTS. Chat behavior and authorization
stay in the existing API; no remote speech endpoint is called.

`playground-speech-preload.ts` prepares Whisper, Silero and Piper when Playground
mounts, without requesting devices or starting any provider generation. Start
call claims those same workers; page navigation releases unclaimed preparation,
and End releases all workers/media owned by the call. Cached public assets are
reused by subsequent calls. Background failure does not break Chat; explicit
Start retries initialization and exposes persistent errors.

`playground-local-stt.ts` retains the pinned Whisper base model with
`language: "en"` for every transcription, WebGPU or quantized WASM and no audio
upload. Automatic language detection is removed; local speech is English-only.
`playground-local-vad.ts` retains Silero classification, 300 ms pre-roll and
separate browser echo/noise processing. `playground-local-tts.ts` runs pinned
Piper `en_US-ljspeech-medium` with eSpeak `en` in one worker using
the existing ONNX Runtime and single-thread CPU/WASM. There are no text-language
heuristics or secondary voices. Both phonemization and inference stay off the main thread;
TTS requires neither WebGPU nor cross-origin isolation. Model and phonemizer
assets are size-bounded and SHA-256 verified on download and cache reads.
Corrupt cache entries are replaced; unavailable storage does not block calls.
The English model session and verified phonemizer bytes are reused within the call.
Piper returns native mono 22,050 Hz PCM for playback and recording.

`playground-voice-playback.ts` accepts local PCM, buffers consecutive chunks and
connects every source to both speakers and the local recording mix. Text remains
immediate while speech is generated. Barge-in cancels provider generation,
queued synthesis and playback; obsolete inference results are discarded. End
terminates the workers. See [ADR-0040](../../../docs/decisions/0040-browser-speech-activity-detection.md)
and [ADR-0041](../../../docs/decisions/0041-uniform-local-whisper-calls.md), with
the current TTS choice in [ADR-0042](../../../docs/decisions/0042-piper-local-speech-output.md)
and the current English-only speech policy in [ADR-0044](../../../docs/decisions/0044-english-only-local-call-speech.md).

Mode and Voice/Camera preferences persist in localStorage independently of device
cleanup. First use defaults to Chat; restoring either call mode never starts media
automatically. Legacy saved `voice` is migrated after account discovery to the
call mode of its previously eligible provider (requested provider, then first
accessible call provider). Until an eligible account is known, it displays Call
Live with Start disabled and retains the legacy preference for later sign-in or
successful discovery. Changing call modes ends the previous call before a new explicit
Start; supported account selections and the Chat draft are retained.
Native ChatGPT keeps its provider-controlled turn boundaries and incremental
transcripts. See [ADR-0033](../../../docs/decisions/0033-groq-api-key-chat-and-call.md)
and [ADR-0039](../../../docs/decisions/0039-local-language-detection-and-buffered-speech.md).

Zoom Screen expands Setup above the existing Chat or Call conversation over the
viewport without remounting either. Setup remains available with its usual
in-call restrictions; shell controls are covered and inert until Exit Zoom or
Escape restores them. Open Setup dropdowns and recording menus/dialogs handle
Escape first. On short screens the zoomed workspace scrolls to keep both Setup
and the conversation accessible. Zoom uses component state only and resets on reload. Call setup
eligibility is reflected by the disabled Start call button; model dropdown
states and actual errors remain in Setup.
