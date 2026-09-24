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
- `/tools` shows shared tools, currently Gateway, OpenCode and OMP. The existing
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
  requires sign-in and requests are pinned to the chosen account. Images use
  native provider blocks; text files and extracted PDF text join the prompt. See [ADR-0025](../../../docs/decisions/0025-session-backed-playground.md).
- `/organization` selects one of the signed-in user's organizations and shows
  team totals, daily requests and shared agents. Creation accepts an optional
  description of up to 350 characters. `/organization/agents` lets any accepted
  member or owner share their own existing or newly connected account through
  Connect Agent; all accepted members can use it, and the sharer or owner can
  remove it. The page also shows available agents;
  `/organization/members` lets the owner invite and remove users;
  `/organization/usage` filters request and reported token totals by period,
  member, agent and model. The API checks accepted membership for every view.

Removed pages have no route modules or dedicated redirect handlers. The existing
generic catch-all returns unknown URLs to Home.

The frontend is a prerendered SPA. Tools is static; account/session data uses
TanStack Query and the Rust API. Route-only tool components live beside their
route under `src/routes/_app.tools.($contributor)/`.

## Static tool documentation

`src/services/catalog/` reads `contributors/*/tools/` using eager raw imports.
Gateway, OpenCode and OMP keep their existing presentation and ordering; new tool
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
