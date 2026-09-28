# OMP

Install one OMP configuration for every provider pool available through your
Hub William gateway key. OMP is the coding agent “with the IDE wired in”; this
installer refreshes the Hub provider block while preserving unrelated config.

## Install

```sh
curl -fsSL https://hub.example/omp.py | python3 - --url=https://api.hub.example
```

Enter the key in the hidden prompt to keep it out of shell history. The
installer writes its managed provider block to
`~/.omp/agent/models.yml` (or an existing `models.yaml`), creates one backup,
and writes with owner-only permissions. If OMP still has a legacy `models.json`,
run `omp models` once to let OMP migrate it before rerunning the installer.

To pass an existing key explicitly, append `--key=YOUR_GATEWAY_KEY` after the
URL and replace the placeholder. The key may remain in shell history. A revoked
or invalid Hub key stops the installer without changing your config.

## Models

Run `omp` and use `/model` to switch provider or model. Re-run the install
command whenever a connected pool's catalogue changes. Claude, Grok, DeepSeek, and Groq model IDs come from their authenticated live Hub catalogues. Codex IDs
come from the Hub Codex catalogue. Gemini/AGY IDs come from the authenticated
Hub catalogue, restricted to the connected pool's live intersection with the
current [Antigravity model set](https://antigravity.google/docs/models/#models)
and its selectable [headless CLI variants](https://www.antigravity.google/docs/cli/headless/).
Installing OMP does not require a local `agy` executable.

The provider mappings use OMP's native custom-provider APIs:

- Codex, Grok, DeepSeek, and Groq use `openai-responses`.
- Claude uses `anthropic-messages`.
- Gemini/AGY uses `google-generative-ai`.

DeepSeek's Responses mapping avoids treating a long coding-agent turn as a
successful Chat Completions stream unless the provider actually sends a
terminal event.

The installer and gateway do not add input-token, output-token, context,
request-size, or total-generation-duration limits. OMP and the selected
upstream provider keep their native behavior; add a local override yourself
only when you want a smaller budget.

Grok connections created before the current Build scopes were introduced must
be reconnected once in `/agents`, then this installer must be run again. If the
live Grok catalogue is temporarily unavailable while another provider remains
reachable, that provider is omitted until live discovery succeeds. If no
models can be discovered, it stops without changing the config. It never falls
back from subscription quota to a paid xAI API key.

## Ownership and security

The OMP file contains one revocable Hub gateway key, never an upstream API key
or provider OAuth token. Treat it as a password and revoke it from Hub William
if the machine is lost or compromised.

## Shared provider catalogue

<!-- provider-catalogue: begin (generated) -->
| Provider     | Chat models in the reviewed catalogue                                                                                                                                                                                                                                                                                                                   | Call                               | Client protocol        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------- |
| ChatGPT      | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`                                                                                                                                                                                                                                                                | Playground: native realtime        | `openai-responses`     |
| Claude       | `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`                                                                                                                                                                                                                                                                   | —                                  | `anthropic-messages`   |
| Gemini / AGY | `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low`, `gemini-3.6-flash-high`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-low`, `gemini-3.1-pro-high`, `gemini-3.1-pro-low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium` | —                                  | `google-generative-ai` |
| Grok         | `grok-4.7`                                                                                                                                                                                                                                                                                                                                              | —                                  | `openai-responses`     |
| DeepSeek     | `deepseek-flash`, `deepseek-v4-pro`                                                                                                                                                                                                                                                                                                                     | —                                  | `openai-responses`     |
| Groq         | `qwen/qwen3.8-27b` (preview), `openai/gpt-oss-20b`, `openai/gpt-oss-120b`                                                                                                                                                                                                                                                                               | Playground: Local STT → Chat → TTS | `openai-responses`     |

Generated from `apps/api/src/provider_catalogue.json`. Model availability is checked live through Hub; this reviewed snapshot is not proof of account access. Call profiles are Playground-only; coding-client lists contain only chat-capable model IDs.
<!-- provider-catalogue: end -->
