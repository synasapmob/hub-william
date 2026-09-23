# Agent gateway installer

Connect Codex, Claude Code, Antigravity (AGY), and Grok to a Hub William gateway key without
replacing the rest of their machine configuration.

Create the key once on `/agents`. After that, either run the installer or paste
the matching block into the agent config yourself. Restart the selected CLI so
it loads the new upstream.

## Interactive install

The public bootstrap is a Python file, a standalone Python installer: curl pipes
it into `python3 -`, and flags after `-` belong to the installer, not to curl.

```bash
curl -fsSL https://<hub-william-origin>/gateway.py | python3 - --url=https://<hub-william-origin>/api
```

Local development uses `--url=http://localhost:8080`. Copy the filled command
from `/tools?node=gateway` so the origin matches the site you are using.

The picker starts with Codex, Claude Code, Antigravity, and Grok selected. Use the up and
down arrows to move, Space to toggle `[x]`, Enter to inject the key into only
those configs, or Escape to quit without writing. The installer asks for your
key with a hidden prompt after the selection. When `--key` is supplied explicitly,
Enter does not ask again.

`--key` is visible in your shell history; the hidden prompt exists for that
reason. Existing configuration files receive a one-time `.hub-william.bak`
backup. The live files are written atomically with owner-only permissions.

## Destinations

| Agent | File | Gateway protocol |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | OpenAI Responses |
| Claude Code | `~/.claude/settings.json` | Anthropic Messages |
| Antigravity (AGY) | `~/.gemini/antigravity-cli/settings.json` and shell profile | Gemini native API via Google OAuth |
| Grok | `~/.grok/config.toml` | OpenAI-compatible chat |

Enter the key shown once when you created it at the installer's hidden prompt.
Replace `https://<hub-william-origin>/api` with the origin printed on the Tools
page. In the manual configuration examples below, replace `YOUR_GATEWAY_KEY`
with your key.

## Codex

`~/.codex/config.toml`

```toml
model_provider = "hub-william"

[model_providers.hub-william]
name = "Hub William"
base_url = "https://<hub-william-origin>/api/gateway/openai/v1"
experimental_bearer_token = "YOUR_GATEWAY_KEY"
wire_api = "responses"
```

Leave every other table in that file alone. `wire_api = "responses"` is
required: Codex talks to `/gateway/openai/v1/responses`.

## Claude Code

`~/.claude/settings.json` — merge these into `env`, do not replace the rest of
the file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<hub-william-origin>/api/gateway/claude",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_GATEWAY_KEY"
  }
}
```

Claude appends `/v1/messages` itself, so the base URL stops at `/gateway/claude`.

## Antigravity (AGY)

Set direct Gemini mode in `~/.gemini/antigravity-cli/settings.json` without
replacing unrelated settings:

```json
{
  "modelProvider": "gemini"
}
```

Add the installer-managed block to the active `~/.zshrc`, `~/.bashrc`, or
`~/.profile`:

```bash
# >>> hub-william agy >>>
export GOOGLE_GEMINI_BASE_URL='https://<hub-william-origin>/api/gateway/gemini'
export GEMINI_API_KEY='YOUR_GATEWAY_KEY'
# <<< hub-william agy <<<
```

AGY sends the Hub key only to Hub William. Hub William exchanges it for the
encrypted Google OAuth connection upstream, so this configuration uses the
connected Gemini subscription instead of separate Developer API billing. Open
a new shell after installation so the managed environment block is loaded.

## Grok

`~/.grok/config.toml`

```toml
[endpoints]
models_base_url = "https://<hub-william-origin>/api/gateway/grok/v1"

[model.grok-build]
base_url = "https://<hub-william-origin>/api/gateway/grok/v1"
api_key = "YOUR_GATEWAY_KEY"
```
