# ADR-0018: Provider-backed AGY model discovery

## Status

Superseded by ADR-0019 — 2026-09-15. Previously superseded ADR-0016's local AGY
catalogue and `countTokens` availability probe.

## Context

The OpenCode and OMP installers used `agy models` on the caller's machine, then
treated one successful `countTokens` request as proof that the connected Hub
pool could generate with that catalogue. This has two independent failure
modes: a piped installer may not inherit the shell path containing `agy`, and
Google's Code Assist `countTokens` endpoint can accept a model that the selected
subscription pool rejects during generation.

Google Code Assist already exposes the models provisioned for the connected
Antigravity credential through `v1internal:fetchAvailableModels`. The catalogue
is a property of the shared pool, not of the machine running the installer.

## Decision

- Expose an authenticated native-style model list at
  `/gateway/gemini/v1beta/models`.
- Build that list from the connected pool's live
  `v1internal:fetchAvailableModels` response, excluding entries explicitly
  marked internal and entries without a display name.
- Make both OpenCode and OMP installers consume the gateway catalogue directly.
  Installing those integrations no longer requires a local `agy` executable.
- Keep generation and model discovery on the same provider-scoped credential
  selection and reauthorization lifecycle.

## Consequences

- Gemini / AGY models appear in OpenCode and OMP when the Hub pool advertises
  them, including when the installer runs with a minimal pipe environment.
- The installer no longer publishes machine-local aliases that the selected
  shared subscription cannot serve.
- Catalogue changes still require rerunning the one-line installer.
