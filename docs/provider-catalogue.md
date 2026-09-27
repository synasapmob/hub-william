# Shared providers and models

[`apps/api/src/provider_catalogue.json`](../apps/api/src/provider_catalogue.json)
is the editable source for public provider/model metadata. The Gateway,
Playground, Agents, OpenCode, OMP and tool documentation consume it directly or
through generated artifacts. It contains no credentials or account entitlements.

[ADR-0038](decisions/0038-shared-provider-model-catalogue.md) defines this ownership
and update workflow; [ADR-0029](decisions/0029-current-provider-model-catalogues.md)
retains the current-model selection and live-availability policy.

## Update once, distribute together

1. Update the source JSON. For a model refresh, verify the current official
   sources and live availability under [ADR-0029](decisions/0029-current-provider-model-catalogues.md).
2. Run `pnpm catalogue:generate` from the repository root.
3. Run `pnpm catalogue:check`, `pnpm catalogue:test` and the relevant app and
   installer checks. Root format checking and builds include the freshness
   check; root tests include the catalogue contract tests.
4. Release the API and frontend together. Users rerun the OpenCode/OMP installer
   to update their local Hub configuration and discover the current models.

The generator produces typed frontend metadata, the Rust provider enum and Call
model constants, embedded Python descriptors, and marked tables in the three tool
docs. Do not edit generated sections. The JSON lives beside the API source so it
is included in the existing Docker build context; the standalone installers
remain dependency-free and work with `curl | python3`.

## What belongs in the catalogue

- Provider IDs, labels, icons, connection type, UI order and usage support.
- Gateway paths, client protocols/auth shapes, OpenCode preferred models and
  supported native CLI configuration metadata.
- Reviewed model IDs, names, current/preview/deprecated status, supported inputs
  and reasoning efforts. Capabilities describe what the Hub integration accepts.
- Call profiles, their transport, model dependencies and availability rule.
  Native realtime and local STT → Chat → TTS remain distinct adapters. A model
  can support both Chat and Call; audio-only models do not enter coding lists.
- `retired_hub_ids`: former managed provider IDs that an installer should clean
  up. When removing a provider entirely, move its `hub_id` here. Removing only a
  client mapping also removes that client's old managed configuration.

Adding a provider with a new authentication or wire protocol still requires its
backend adapter and tests. Metadata cannot implement OAuth, a new API route or a
voice transport. Known protocol mappings are validated instead of silently
falling back to another transport.

## Live availability and installation

Reviewed metadata and live availability serve different purposes. Gateway keeps
the existing official-document parsers and account discovery. Reviewed static
lineups are intersected with live models; native realtime retains its own
availability contract. Empty or inactive live dependencies do not enable a Call.
This change does not introduce a background job that continuously reviews every
provider's latest releases.

OpenCode and OMP install only Chat models returned by the authenticated Gateway.
Bundled metadata enriches those results; it never adds a model missing from live
discovery. Reinstallation replaces Hub-owned provider configuration and removes
stale Hub model routing while preserving personal providers and unrelated
settings. Invalid credentials or entirely empty discovery leave files unchanged.
Gateway's native CLI installer continues to render the configuration supported
by each CLI; it does not install the Playground's Call models.
