# ADR-0015: DeepSeek API keys and OpenCode gateway installation

- Status: Accepted
- Date: 2026-09-15
- Partially superseded by: ADR-0030's daily DeepSeek key validation

## Context

Hub William already exchanges subscription-account authorization with ChatGPT,
Claude, and Grok, encrypts provider credentials, and gives local clients one
revocable user-scoped gateway key. DeepSeek exposes API-key authentication
instead of the browser authorization flow used by those providers. OpenCode can
address several custom providers from one config and owns its own model and
variant pickers.

The separate Antigravity connection was implemented independently and is now
part of the base branch. This decision integrates its existing gateway with
OpenCode without duplicating its authorization flow.

## Decision

- DeepSeek is connected through an authenticated provider-specific endpoint.
  The API key is trimmed and validated against DeepSeek's live model endpoint,
  then stored through the existing AES-256-GCM credential envelope. Plaintext
  is never returned to the browser or written to logs.
- A displayed DeepSeek connection label contains only the final four key
  characters. Static API credentials have no OAuth refresh token and are
  excluded from the periodic OAuth refresh sweep. Manual refresh revalidates
  the stored key.
- DeepSeek chat, Responses, and model-list routes use the existing user-scoped
  gateway-key authorization, provider-scoped pool selection, rate-limit
  cooldown, failover, usage recording, and streaming behavior.
- The OpenCode installer writes only the revocable Hub gateway key. It discovers
  reachable provider models at install time and omits pools the key cannot
  access. Codex model and reasoning metadata comes from the installed
  `codex app-server`; the Hub's current supported list is the fallback.
- OpenCode's native `/models` and `/variants` controls remain authoritative.
  Reasoning-capable installed models default to medium effort. The bundled
  OpenCode Zen provider is disabled in the generated config.
- Antigravity is registered only when `agy models` returns the current local
  catalogue and a non-generating Gemini `countTokens` request confirms that the
  Hub key can reach a Gemini pool. Its provider sends the Hub key in the
  Authorization header; a fixed non-secret placeholder satisfies the Google
  SDK's separate API-key option and is ignored by the Hub proxy.
- The provider constraint retains both `gemini` and `deepseek` so chronological
  deployment of their migrations cannot remove either provider.

## Consequences

- A compromised application host with the credential-encryption key can decrypt
  DeepSeek keys, while a database dump alone cannot. A compromised user machine
  exposes only the revocable Hub key written for OpenCode.
- Supplying `--key` is convenient but can place the Hub key in shell history;
  omitting the flag uses a hidden prompt. The config is backed up once and
  replaced atomically with owner-only permissions.
- Re-running the installer refreshes live model IDs without replacing unrelated
  OpenCode settings. JSONC comments are not retained in the rewritten file, but
  their represented configuration values are preserved and the original file
  remains in the one-time backup.
