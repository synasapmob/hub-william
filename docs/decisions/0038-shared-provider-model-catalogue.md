# ADR-0038: Shared provider and model catalogue

- Status: Accepted
- Date: 2026-09-27
- Authority: operator requested one shared provider/model metadata source for the app, Gateway, OpenCode, OMP and docs, then requested alignment of ADR-0029.
- Partially supersedes: [ADR-0029](0029-current-provider-model-catalogues.md) for catalogue ownership, the update workflow and the historical five-provider verification scope. Its current-model selection, live-availability and generation-compatibility rules remain in force, subject to later provider-specific decisions.

## Context

Provider identities, current model lists, client mappings and capabilities were
maintained in several Rust, TypeScript, Python and Markdown locations. Adding
Groq exposed the risk of updating one surface while leaving another stale.
The shared catalogue implementation now needs an explicit maintenance decision
so a future model refresh follows the same ownership and verification boundaries.

## Decision

- The editable source for public provider/model metadata is
  [`apps/api/src/provider_catalogue.json`](../../apps/api/src/provider_catalogue.json).
  It owns provider identity/presentation, connection metadata, supported client
  mappings, discovery strategy/source URLs, reviewed model IDs/status/capabilities,
  reasoning efforts, client defaults, usage support and Call profiles/dependencies.
  Credentials and account entitlements never belong in this source.
- Rust reads that JSON directly. Run `pnpm catalogue:generate` after metadata
  changes to produce frontend metadata/types, Rust provider and Call constants,
  embedded descriptors in the standalone installers, and the marked provider
  tables in tool docs. Edit the source and generator/templates as appropriate;
  do not hand-edit generated copies or introduce competing current-model lists.
  Historical ADR model examples record their original decision, while current
  lineups are maintained in the catalogue under the applicable selection policy.
- A latest-model refresh covers every provider in the catalogue and each client
  it supports, including Groq. Review the official sources recorded by each
  provider's discovery metadata, relevant supplemental sources in ADR-0029 and
  provider decisions, and authenticated live discovery when available. Apply
  ADR-0029's current/transition/legacy classification before updating metadata.
  Report unavailable entitlement checks. Regeneration synchronizes reviewed
  metadata; it does not independently research new releases or prove access.
- The authenticated Gateway remains the source of model availability for
  OpenCode/OMP. Preserve existing official-document parsers, reviewed-lineup
  filters and account discovery. Installers only configure live Chat models;
  bundled metadata may enrich those models but cannot add an absent model or
  invent a fallback on empty discovery. A live official-document parser can
  discover a current ID newer than the bundled snapshot; the next explicit
  catalogue refresh must synchronize that snapshot and generated docs.
- Capabilities describe implemented Hub behavior. Keep native realtime and
  composed Call profiles distinct. Respect the native Codex availability
  contract in [ADR-0032](0032-playground-native-voice.md) and the Groq local-STT
  profile in [ADR-0037](0037-browser-local-speech-recognition.md). Groq requires
  its live Chat/TTS dependencies, without a remote STT requirement. A model may
  have both Chat and Call modes; audio-only models stay out of coding lists.
  Adding metadata alone cannot implement a new auth, usage or wire-protocol
  adapter; new transports require their implementation and verification.
- Reinstallation replaces Hub-managed configuration and stale Hub model routing
  while preserving personal providers and unrelated settings. When removing a
  provider entirely, retain its former Hub ID in `retired_hub_ids` for cleanup.
  OpenCode/OMP leave configuration unchanged on invalid credentials or entirely
  empty model discovery. Deploy API/frontend changes together and rerun local
  installers to distribute the update; existing installations do not self-update
  continuously.
- Before handing off a catalogue update, run `pnpm catalogue:check`,
  `pnpm catalogue:test` and the applicable API, frontend and installer checks.
  Root `format:check` and `build` enforce generated-artifact freshness; root
  `test` includes catalogue contract tests. The freshness check compares generated
  artifacts with the source; reviewing prose and accepted transport decisions
  for consistency remains part of the update.

## Consequences

One metadata edit plus generation updates the maintained consumers without
changing their protocol adapters or granting access to models. Standalone Python
installers remain dependency-free. Generated drift fails checks, while official
source review, live verification and release/install timing remain explicit work.

See the [catalogue maintenance guide](../provider-catalogue.md) for the procedure.
