# Agent gateway installer

Connect Codex, Claude Code, and Grok to a Hub William gateway key without
replacing the rest of their machine configuration.

The Python installer opens a terminal picker with every agent selected. Use the
up and down arrows to move, Space to toggle `[x]`, Enter to install, or Escape
to quit without writing. After Enter it asks for the Hub William API key with
hidden input, then updates only the gateway fields for the selected CLIs.

Existing configuration files receive a one-time `.hub-william.bak` backup. The
live files are written atomically with owner-only permissions. The API key is
stored only in those local agent configuration files and is never printed.

## Destinations

| Agent | File | Gateway protocol |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | OpenAI Responses |
| Claude Code | `~/.claude/settings.json` | Anthropic Messages |
| Grok | `~/.grok/config.toml` | OpenAI-compatible chat |
