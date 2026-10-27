# Architecture

Hub William lets people share the coding-agent subscriptions they already pay
for, and lets their local agents and a browser Playground use them through one
gateway without ever seeing the provider credentials. This page is the map: what
runs where, how a request travels, and which document explains each subsystem.
The code is the source of truth; each document names the files that implement
what it describes.

## What runs where

| Part            | Technology                                   | Role                                                                                                                                                   |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/frontend` | React Router SPA, TypeScript                 | Home, Tools, Agents, Organization and Playground. Built to static files and served by nginx.                                                           |
| `infra/nginx`   | nginx                                        | Public edge. Serves the static build and proxies `/api/` to the private API, except `/api/internal` and `/api/internal/*`, which answer 404.           |
| `apps/api`      | Rust, PostgreSQL                             | Authentication, provider connections, pools, organizations, usage, Tools backends (reel, text to audio) and the streaming gateway, all in one process. |
| `apps/telegram` | Rust                                         | Telegram shop webhook adapter. Has no database and calls the API under `/internal/telegram/*`.                                                         |
| `contributors/` | Markdown and scripts                         | Tool sources. The frontend build reads them and publishes them under `/catalog/`.                                                                      |
| Browser workers | Whisper, Silero, Piper, Vosk                 | Speech recognition, voice activity detection and speech output run on the user's machine and upload no audio.                                          |
| Local agents    | Codex, Claude Code, AGY, Grok, OpenCode, OMP | Configured by the installers to call the gateway with a Hub key.                                                                                       |

The gateway is a module of the API (`apps/api/src/api/gateway/`), merged into
the same router. Playground calls it in-process, so a prompt makes no extra
network hop. Cargo has no workspace: `apps/api` and `apps/telegram` are separate
projects, and `pnpm-workspace.yaml` lists only `apps/frontend`.

## How a request travels

- **Browser to API.** The SPA calls `/api/...` on its own origin. nginx strips
  the prefix and forwards to the API with the session cookies.
- **Local agent to provider.** An installer writes the agent's configuration to
  point at `/api/gateway/<provider>/...` with a Hub key. The gateway resolves the
  key to a user, picks one of that user's reachable accounts, injects the
  provider credential and streams the response back. See
  [gateway](./architecture/gateway.md).
- **Playground to provider.** The browser sends `POST /api/playground/chat` (or
  `/api/playground/voice` for Call Live) with its session. The API runs the same
  account selection and failover as the gateway and streams the answer. See
  [Playground](./architecture/playground.md).
- **Telegram to API.** Telegram posts to the adapter's `/webhook`; the adapter
  reads and writes shop data through the API's internal routes. See
  [Telegram](./architecture/telegram.md).

## Vocabulary

| Term                | Meaning                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Connection          | A provider account a user linked (ChatGPT, Claude, Gemini, Grok, DeepSeek or Groq). Credentials stay encrypted on the server. |
| Pool                | A connected account that other users may ask to join. An accepted member can use it through their own Hub key.                |
| Hub key             | A user-scoped gateway key (`hw_live_…`). It identifies the user, not one provider.                                            |
| Scope               | Personal (accounts the user owns or joined) or one organization (accounts shared into it).                                    |
| Organization agent  | A link to a member's connection shared into an organization. It is not a copy.                                                |
| Call Live / Whisper | Playground call modes: a native provider call, or browser-local speech around the chat API.                                   |

## Documents

| Document                                                   | Covers                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Frontend](./architecture/frontend.md)                     | Routes, session client, query cache, prerendering, skeleton loading, the Agents page.        |
| [Accounts and pools](./architecture/accounts-and-pools.md) | Sessions, provider connect flows, credential storage, pools, availability, refresh schedule. |
| [Organizations](./architecture/organizations.md)           | Membership, default organization, linked agents, usage reporting.                            |
| [Gateway](./architecture/gateway.md)                       | Routes, Hub-key auth, account selection, failover, retries, provider specifics.              |
| [Provider catalogue](./provider-catalogue.md)              | The one JSON source for providers, models and call profiles, and its generated consumers.    |
| [Playground](./architecture/playground.md)                 | Chat, Call Live and Call Whisper: eligibility, setup, limits.                                |
| [Speech](./architecture/speech.md)                         | Browser-local speech pipeline, recordings, Vosk, text to audio.                              |
| [Tools](./architecture/tools.md)                           | Tool catalogue, contribution policy, installers, reel, memory tool.                          |
| [Telegram](./architecture/telegram.md)                     | The shop adapter and its payment settlement.                                                 |
| [Deployment](./architecture/deployment.md)                 | Environments, CI, nginx, configuration, local development.                                   |
| [Decisions](./decisions/README.md)                         | The few records that explain a constraint the code cannot show.                              |
