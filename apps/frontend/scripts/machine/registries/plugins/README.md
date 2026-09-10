# Vendor plugins

One `<name>.toml` per plugin. `sync` runs the vendor CLI for each agent listed,
best effort: a failed `plugin install` is reported and does not roll back the
skills or MCP servers that already applied.

```toml
description = "What it does"
marketplace = "codex-warp"                             # optional
source = "https://github.com/warpdotdev/codex-warp.git" # optional; added first
plugin = "warp"
agents = ["claude"]
```

Empty on purpose. Plugins are the one part of this installer that shells out to
someone else's installer, so nothing ships here by default.
