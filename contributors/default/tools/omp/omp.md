# OMP

Install one OMP configuration for every provider pool available through your
Hub William gateway key. OMP is the coding agent “with the IDE wired in”; this
installer replaces the existing OMP provider config with a fresh Hub catalogue.

## Install

```sh
curl -fsSL https://hub.example/omp.py | python3 - --url=https://api.hub.example --key=YOUR_GATEWAY_KEY
```

Omit `--key` to enter the key in a hidden prompt and keep it out of shell
history. The installer writes a fresh `providers:` document to
`~/.omp/agent/models.yml` (or an existing `models.yaml`), creates one backup,
and writes with owner-only permissions. If OMP still has a legacy `models.json`,
run `omp models` once to let OMP migrate it before rerunning the installer.

## Models

Run `omp` and use `/model` to switch provider or model. Re-run the install
command whenever a connected pool's catalogue changes. Claude, Grok, and
DeepSeek model IDs come from their authenticated live Hub catalogues. Codex IDs
come from the Hub Codex catalogue. Gemini/AGY IDs come from the authenticated
Hub catalogue, restricted to the connected pool's live intersection with the
current [Antigravity model set](https://antigravity.google/docs/models/#models)
and its selectable [headless CLI variants](https://www.antigravity.google/docs/cli/headless/).
Installing OMP does not require a local `agy` executable.

The provider mappings use OMP's native custom-provider APIs:

- Codex, Grok, and DeepSeek use `openai-responses`.
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
live Grok catalogue is temporarily unavailable, the installer still writes the
`hub-grok/grok-build` entry so the provider remains selectable. It never falls
back from subscription quota to a paid xAI API key.

## Ownership and security

The OMP file contains one revocable Hub gateway key, never an upstream API key
or provider OAuth token. Treat it as a password and revoke it from Hub William
if the machine is lost or compromised.
