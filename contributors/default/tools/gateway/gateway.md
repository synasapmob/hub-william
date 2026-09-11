# Agent gateway installer

Connect Codex, Claude Code, and Grok to a Hub William gateway key without
replacing the rest of their machine configuration.

Create the key once on `/agents`. After that, either run the installer or paste
the matching block into the agent config yourself. Restart the selected CLI so
it loads the new upstream.

## Interactive install

The public bootstrap is a Python file, same shape as `install.py`: curl pipes
it into `python3 -`, and flags after `-` belong to the installer, not to curl.

```bash
curl -fsSL https://<hub-william-origin>/gateway.py | python3 - --url=https://<hub-william-origin>/api --key=YOUR_GATEWAY_KEY
```

Local development uses `--url=http://localhost:8080`. Copy the filled command
from `/tools?node=gateway` so the origin matches the site you are using.

The picker starts with Codex, Claude Code, and Grok selected. Use the up and
down arrows to move, Space to toggle `[x]`, Enter to inject the key into only
those configs, or Escape to quit without writing. When `--key` is present,
Enter does not ask again. Omit `--key` to type it hidden after the selection.

`--key` is visible in your shell history; the hidden prompt exists for that
reason. Existing configuration files receive a one-time `.hub-william.bak`
backup. The live files are written atomically with owner-only permissions.

## Destinations

| Agent | File | Gateway protocol |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | OpenAI Responses |
| Claude Code | `~/.claude/settings.json` | Anthropic Messages |
| Grok | `~/.grok/config.toml` | OpenAI-compatible chat |

Replace `YOUR_GATEWAY_KEY` with the key shown once when you created it. Replace
`https://<hub-william-origin>/api` with the origin printed on the Tools page.

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

## Grok

`~/.grok/config.toml`

```toml
[endpoints]
models_base_url = "https://<hub-william-origin>/api/gateway/grok/v1"

[model.grok-build]
base_url = "https://<hub-william-origin>/api/gateway/grok/v1"
api_key = "YOUR_GATEWAY_KEY"
```
