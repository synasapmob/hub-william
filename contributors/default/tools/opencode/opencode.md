# OpenCode

Install one OpenCode configuration for every provider pool available through
your Hub William gateway key. The installer discovers provider models at run
time, refreshes its managed providers while preserving other settings, makes
one backup, and writes the result atomically with owner-only permissions.

## Install

```sh
curl -fsSL https://hub.example/opencode.py | python3 - --url=https://api.hub.example
```

Enter the key in the hidden prompt to keep it out of shell history. OpenCode
needs the Hub key in `~/.config/opencode/opencode.json` for
unattended requests; upstream Claude, Codex, Gemini/AGY, Grok, and DeepSeek
credentials remain encrypted on Hub William and are never written to the
machine.

To pass an existing key explicitly, append `--key=YOUR_GATEWAY_KEY` after the
URL and replace the placeholder. The key may remain in shell history. A revoked
or invalid Hub key stops the installer without changing your config.

The built-in OpenCode provider is disabled, so OpenCode Zen does not appear
unless you remove `opencode` from `disabled_providers` yourself.

## Models and effort

Run `opencode`, use `/models` to switch providers or models, and use OpenCode's
native `/variants` picker to switch reasoning effort. Supported reasoning
variants come from the installed model catalogue and start at `medium` where
the provider supports effort. AGY exposes some effort levels as separate model
IDs, so those remain separately selectable in `/models`.

Re-run the command whenever provider catalogues change. Claude, Codex, Grok,
and DeepSeek model IDs are fetched through the live Hub pools; Grok uses its
authenticated Build catalogue, and Grok and DeepSeek use the Responses
protocol. Codex model names and reasoning levels come from the installed
`codex app-server` where available, with supported fallback metadata for known
models. A gateway model absent from that metadata still appears by name.
Gemini/AGY IDs come from the authenticated Hub catalogue, which exposes only
the intersection of the connected pool's live models and the current
[Antigravity model set](https://antigravity.google/docs/models/#models). This
includes the selectable high, medium, and low AGY variants documented by the
[headless CLI reference](https://www.antigravity.google/docs/cli/headless/).
Installing OpenCode does not require a local `agy` executable. If no Gemini
pool is connected, that provider is omitted and the installer prints why.

The installer and gateway do not add input-token, output-token, context,
request-size, or total-generation-duration limits. OpenCode and the selected
upstream provider keep their native behavior; add a local override yourself
only when you want a smaller budget.

Grok connections created before the current Build scopes were introduced must
be reconnected once in `/agents`, then this installer must be run again. If the
live Grok catalogue is temporarily unavailable while another provider remains
reachable, the installer still writes the `hub-grok/grok-build` entry. If no
models can be discovered, it stops without changing the config. It never falls
back from subscription quota to a paid xAI API key.

## Security

The OpenCode file contains one revocable Hub gateway key, never a DeepSeek API
key or provider OAuth token. Treat the Hub key as a password: keep the config
private, prefer hidden input on shared machines, and revoke the key from Hub
William if the machine is lost or compromised.
