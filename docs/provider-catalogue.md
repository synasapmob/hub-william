# Shared providers and models

[`apps/api/src/utils/provider_catalogue/catalogue.json`](../apps/api/src/utils/provider_catalogue/catalogue.json)
is the editable source for public provider and model metadata. The gateway
([architecture/gateway.md](./architecture/gateway.md)), the Playground, Agents,
the OpenCode, OMP and Gateway installers, and the tool documentation consume it
directly or through generated artifacts. It contains no credentials and no account
entitlements.

## Update once, distribute together

1. Update the source JSON. For a model refresh, review the current official sources
   and live availability as described under [Current lineup](#current-lineup).
2. Run `pnpm catalogue:generate` from the repository root.
3. Run `pnpm catalogue:check`, `pnpm catalogue:test` and the relevant app and
   installer checks. Root `format:check` and `build` run the freshness check, and
   root `test` runs the catalogue contract tests.
4. Release the API and frontend together. Users rerun the OpenCode or OMP installer
   to update their local Hub configuration and discover the current models.

`scripts/provider-catalogue.py` validates the source and rewrites its consumers.
`--check` reports stale artifacts without writing. Do not edit generated sections.

| Consumer                | Generated artifact                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Frontend metadata/types | `apps/frontend/src/services/provider-catalogue/provider-catalogue.generated.ts`     |
| Rust provider enum      | `apps/api/src/utils/provider_catalogue/generated.rs` (`AgentProvider`, call models) |
| Standalone installers   | marked blocks in `apps/frontend/public/{opencode,omp,gateway}.py`                   |
| Tool documentation      | marked tables in `contributors/default/tools/{opencode,omp,gateway}/*.md`           |

The Rust API reads the JSON directly (`include_str!`), so the JSON sits beside the
API source and is part of the Docker build context. The standalone installers stay
dependency-free and work with `curl | python3`.

## Source layout

Top-level keys: `schema_version` (`1`), `providers`, `call_profiles`, `surfaces`,
`opencode_default_providers`, `retired_hub_ids`.

**Provider** (`providers[]`):

- Identity and presentation: `id`, `label`, `connect_label`, `icon`,
  `catalogue_key` (the key installers use) and `hub_id` (the managed provider id
  written into client configuration, always `hub-…`).
- `auth`: `oauth`, or `api_key` with `connect_path` (`/agent-connections/<id>`) and
  `key_placeholder`.
- `usage_metrics`: whether the Agents UI and organization views show provider
  quota. It is `true` for ChatGPT and Claude.
- `chat_capabilities`: `chat` plus optionally `image_input`. They apply to any model
  id the provider lists that the catalogue does not.
- `discovery`: `strategy` and `docs_url` (below).
- `gateway`: `base_path`, `models_path` and `owned_by`.
- `clients`: `opencode` (`npm` adapter, `auth`, `effort_option`, `metadata_adapter`,
  `preferred_models`, optional `base_path`) and `omp` (`api`). The set of values is fixed in the
  validator.
- `native_cli` (optional): the config file, base path and protocol the Gateway
  installer writes for a native CLI (`codex`, `claude`, `agy`, `grok`).
- `models[]`: `id`, `name`, `status` (`current`, `preview` or `deprecated`),
  `capabilities` and optional `reasoning_efforts`.

**Capabilities** describe what the Hub integration accepts: `chat`, `image_input`,
`realtime_audio`. A **chat model** is one whose
status is not `deprecated` and whose capabilities include `chat`
(`ProviderDefinition::chat_models`). The audio-only model `gpt-live-1-codex` is not a chat model and stays out of
coding-client lists.

**`surfaces`** orders the providers on four surfaces: `agents`, `connect`,
`playground` and `installers`. Each list must name every provider exactly once.

**`opencode_default_providers`** (`chatgpt`, `claude`) is the order in which the
OpenCode installer picks its default `model` when the user has none: the first
installed provider in the list, using the first of its `preferred_models` that was
installed, else its first installed model.

**`retired_hub_ids`**: managed provider ids that an installer should clean from
client configuration. When a provider is dropped entirely, move its `hub_id` here.
Dropping only a client mapping also drops that client's managed entry.

The Rust API deserializes only the fields it needs (`id`, `label`, `usage_metrics`,
`chat_capabilities`, `discovery`, `gateway.owned_by`, `models`, `call_profiles`).
The validator in `scripts/provider-catalogue.py` rejects unknown fields, duplicate
ids, dangling references, preferred models that are not current chat models, and
call profiles whose dependencies are missing or have the wrong capability.

## Call profiles

A call profile describes a native Playground call for one provider: `kind`,
`transport`, `selector_model` (the id shown in the model picker), `availability`
and `models` (its dependencies by role). There is one:

| Kind              | Provider | Transport         | Availability     | Dependencies     |
| ----------------- | -------- | ----------------- | ---------------- | ---------------- |
| `native_realtime` | ChatGPT  | `codex_v3_webrtc` | `chat_catalogue` | `realtime` model |

- The generator hard-codes this pairing: a profile must use that kind, provider,
  transport and availability rule. Metadata cannot implement a new voice
  transport; that needs backend and frontend code. Call Whisper has no profile:
  every provider with the `chat` capability can run it.
- `call_available` (`apps/api/src/utils/provider_catalogue/mod.rs`) evaluates
  availability. `chat_catalogue` holds when the account lists at least one chat
  model.
- A model can support both Chat and a call; its picker entry gains the call mode
  when the profile is available. How the Playground uses the profile is in
  [architecture/playground.md](./architecture/playground.md).

## Discovery and the current lineup

`discovery.strategy` says how the gateway builds a provider's model list. Live
account discovery always decides availability; the catalogue supplies names, effort
metadata and the lineup, and never adds a model the account does not list.

| Strategy            | Providers                    | Lineup source                                                                    |
| ------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `official_docs`     | ChatGPT, Claude              | The provider's docs page is parsed at runtime and intersected with the live list |
| `live_intersection` | Gemini, Grok, DeepSeek, Groq | The reviewed `models[]` list is intersected with the live list                   |

For `official_docs`, a current id that appears in the docs and the live list is
offered without a code change; the catalogue snapshot is the fallback when the docs
fetch fails and supplies metadata for ids it knows. For `live_intersection`, the
reviewed list is the lineup, so it needs a manual refresh. `docs_url` is only fetched
at runtime for `official_docs`. Details and caching are in
[architecture/gateway.md](./architecture/gateway.md#model-discovery).

### Current lineup

A "latest models" refresh covers every provider and every client surface, not one
top model:

- Review each provider's `discovery.docs_url` and, when credentials are available,
  authenticated live discovery.
- Include the whole current or recommended lineup, including an older model that
  official guidance explicitly keeps during a transition.
- Exclude legacy, deprecated, retired, previous-generation and duplicate alias
  entries, even when an upstream endpoint still lists them. A provider's `/models`
  response is not a current-only list.
- Regeneration synchronizes reviewed metadata. It does not research new releases
  and does not prove that an account can use a model; report an unchecked
  entitlement as a gap.
- Saved model ids can still be sent to generation routes. The upstream provider
  decides whether it accepts them.

## Installation

OpenCode and OMP install only the chat models that the authenticated gateway
returns. Bundled metadata enriches those results and never adds a model that live
discovery lacks. An empty discovery leaves the files unchanged and the installer
does not invent a fallback id. Invalid credentials also leave files unchanged.
Reinstalling replaces the Hub-managed provider configuration and stale Hub model
routing while preserving personal providers and unrelated settings.

The Gateway installer renders the native CLI configuration each CLI supports
(`native_cli`); it does not install Playground call models.

Adding a provider with a new authentication method or wire protocol still needs its
backend adapter and tests. Metadata cannot implement OAuth, a new API route or a
voice transport, and the validator rejects unknown protocol mappings instead of
falling back to another transport.
