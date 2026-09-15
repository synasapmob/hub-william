# ADR-0017: OMP one-command provider installation

## Status

Accepted — 2026-09-15.

## Context

OMP loads custom providers from `~/.omp/agent/models.yml` or
`~/.omp/agent/models.yaml`. Hub William already exposes separate subscription
gateway surfaces for Codex, Claude, Gemini/AGY, Grok, and DeepSeek, but manually
copying those endpoints and their current model catalogues into OMP is fragile.
The `/tools` catalogue already establishes a one-command installer pattern for
OpenCode.

## Decision

- Publish `omp.py` as a dependency-free, same-origin installer from the
  `/tools/omp` collection.
- Discover reachable model IDs at install time and map them to OMP's native
  custom-provider APIs: `openai-responses`, `anthropic-messages`,
  `google-generative-ai`, and `openai-completions`.
- Store only the revocable Hub gateway key locally. Upstream OAuth credentials
  and provider API keys remain encrypted in Hub William.
- Preserve unrelated YAML bytes. The installer owns one marked region inside
  the root `providers:` mapping, replaces that region on rerun, and refuses
  malformed roots or same-name providers outside its markers.
- Follow OMP's current `.yml` then `.yaml` precedence and refuse to shadow an
  unmigrated legacy `models.json`.

## Consequences

- One command makes all reachable Hub pools selectable through OMP's `/model`
  picker without changing the user's saved role routing.
- Catalogue changes require rerunning the installer; no remote provider-config
  source is assumed.
- The Hub key necessarily exists in OMP's local model configuration for
  unattended requests, so the file and its one-time backup use owner-only
  permissions.
- Existing Grok credentials still need explicit reauthorization when the Hub
  OAuth scope contract changes.
