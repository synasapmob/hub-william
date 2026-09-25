# ADR-0029: Current provider model catalogue convention

- Status: Accepted
- Date: 2026-09-25
- Supersedes: ADR-0025's allowance for older advertised models in gateway model lists. Existing saved generation requests remain compatible.

## Context

Provider model endpoints and broad documentation indexes may continue to list old,
deprecated, retired, or compatibility alias IDs. Installing every advertised ID
made OpenCode and OMP pickers show models that are no longer the current lineup.
The operator wants all newly current models across providers, without legacy
entries, whenever they request a latest-model update.

## Decision

- Treat “pull/update the latest models” as a full catalogue refresh for every
  supported provider and client surface, not a request for only one top model.
  Review current official provider documentation and authenticated live model
  discovery at the time of the request. Include every model in the current or
  recommended lineup, including an explicitly current transition/rollout lineup.
  Exclude legacy, deprecated, retired, previous-generation, and duplicate alias
  entries even when an upstream endpoint still advertises them. An older model
  remains in the picker only if current official guidance explicitly keeps it
  in the lineup during a transition.
- Use [ChatGPT Learn models](https://learn.chatgpt.com/docs/models?surface=app)
  for Codex, [Claude models overview](https://platform.claude.com/docs/en/models/overview)
  for Claude, the [AGY model matrix](https://www.antigravity.google/docs/models/)
  and [CLI IDs](https://www.antigravity.google/docs/cli/headless/) for Gemini,
  [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)
  for DeepSeek, and [xAI models](https://docs.x.ai/developers/models) for Grok.
  Check each source's current and legacy sections rather than assuming the
  provider's full `/models` response is a current-only list. If a source changes,
  find its new official location before changing the catalogue.
- The Hub's authenticated gateway catalogue is the installer source of truth.
  Codex and Claude catalogues select current documentation entries; AGY selects
  the intersection of official CLI IDs and the connected pool's live catalogue;
  Grok and DeepSeek intersect their live provider catalogues with the current
  official IDs. OpenCode and OMP must not add a model absent
  from the Hub catalogue or invent a fallback ID when live discovery is empty.
  The Playground also limits its picker to current officially documented models
  that the chosen account advertises.
- Refresh the bundled fallback catalogue and OpenCode model metadata/defaults
  in the same change as the live parser. Update contract tests with both current
  and legacy examples, and verify all five providers through the gateway and
  both installers when credentials are available. If live entitlement cannot be
  checked, state that gap instead of treating documentation as proof of access.
- These rules apply to model discovery and pickers. Existing saved model IDs may
  still be sent to generation routes; upstream remains the authority on whether
  that request is accepted. Do not rewrite user-owned configurations outside the
  Hub-managed provider blocks.

## Consequences

The catalogue can change when official docs or live entitlement changes. A
provider may temporarily have no selectable models if its authenticated
catalogue is empty; installers do not mask that state with a guessed ID.
Future latest-model requests must revisit all listed sources and synchronized
fallbacks, picker filters, installer metadata, and tests.
