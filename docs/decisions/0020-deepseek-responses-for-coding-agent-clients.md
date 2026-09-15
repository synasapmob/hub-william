# ADR-0020: DeepSeek Responses for coding-agent clients

## Status

Accepted — 2026-09-15. Amends the client-protocol portions of ADR-0015 and
ADR-0017; their credential, gateway, and ownership decisions remain current.

## Context

DeepSeek supports both Chat Completions and Responses. Hub William originally
configured OMP and OpenCode through Chat Completions. Short requests usually
completed, but real long-context OMP sessions repeatedly ended after receiving
partial data without either a non-null `finish_reason` or the `[DONE]`
sentinel. The client correctly classified those streams as incomplete.

The gateway cannot safely invent a terminal Chat Completions chunk: a clean
`stop` would make truncated text or an incomplete tool call appear successful.
DeepSeek's Responses API instead has explicit completed, incomplete, and failed
terminal events and is supported natively by both coding clients.

## Decision

- OMP installs DeepSeek with the `openai-responses` API.
- OpenCode installs DeepSeek through `@ai-sdk/openai`, which uses the Responses
  endpoint for this provider configuration.
- The existing authenticated `/gateway/deepseek/responses` route remains the
  coding-client path and continues to use the same pool selection, usage
  recording, and streaming behavior.
- The Chat Completions route remains available for compatible direct API
  callers. The gateway does not synthesize missing `finish_reason` or `[DONE]`
  frames.
- Release verification covers a normal response, a tool call, and a copied
  large-context session rather than relying only on a short text prompt.

## Consequences

- Installed OMP and OpenCode clients no longer depend on Chat Completions'
  `finish_reason` for DeepSeek agent turns.
- A genuine Responses stream failure remains visible as an incomplete or failed
  response instead of being mislabeled as success.
- Existing installations must rerun the one-command installer once to replace
  the DeepSeek provider mapping.
