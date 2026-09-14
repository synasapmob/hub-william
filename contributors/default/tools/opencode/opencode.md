# OpenCode

Install one OpenCode configuration for every provider pool available through
your Hub William gateway key. The installer discovers provider models at run
time, preserves unrelated OpenCode settings, makes one backup, and writes the
result atomically with owner-only permissions.

## Install

```sh
curl -fsSL https://hub.example/opencode.py | python3 - --url=https://api.hub.example --key=YOUR_GATEWAY_KEY
```

Omit `--key` to enter the key in a hidden prompt and keep it out of shell
history. OpenCode needs the Hub key in `~/.config/opencode/opencode.json` for
unattended requests; upstream Claude, Codex, Gemini/AGY, Grok, and DeepSeek
credentials remain encrypted on Hub William and are never written to the
machine.

The built-in OpenCode provider is disabled, so OpenCode Zen does not appear
unless you remove `opencode` from `disabled_providers` yourself.

## Models and effort

Run `opencode`, use `/models` to switch providers or models, and use OpenCode's
native `/variants` picker to switch reasoning effort. Supported reasoning
variants come from the installed model catalogue and start at `medium` where
the provider supports effort. AGY exposes some effort levels as separate model
IDs, so those remain separately selectable in `/models`.

Re-run the command whenever provider catalogues change. Claude, Grok, and
DeepSeek model IDs are fetched through the live Hub pools. Codex model IDs and
supported reasoning levels come from the installed `codex app-server`; when
Codex is unavailable, the installer uses the current supported fallback list.
Gemini/AGY model IDs come from the installed `agy models` command after a
non-generating `countTokens` probe confirms that the Hub key can reach a Gemini
pool. If AGY is not installed or no Gemini pool is connected, that provider is
omitted.

## Security

The OpenCode file contains one revocable Hub gateway key, never a DeepSeek API
key or provider OAuth token. Treat the Hub key as a password: keep the config
private, prefer hidden input on shared machines, and revoke the key from Hub
William if the machine is lost or compromised.
