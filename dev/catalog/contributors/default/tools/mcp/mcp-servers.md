# MCP servers

Model Context Protocol servers are registered per agent, in each agent's own
configuration format. The installer writes those blocks so the three formats
stay in step.

## Quick install

```bash
# All configured MCP servers
curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 - --mcp all

# Selected products
curl -fsSL https://synasapmob.github.io/hub-william/install.py | python3 - --mcp linear,playwright
```

The product identifiers are `notion`, `linear`, `playwright`,
`chrome-browser` and `supabase`. Supabase expands to the configured
project-scoped servers; it never creates one account-wide connection.

## Adding one

```bash
./install.sh mcp add playwright npx @playwright/mcp@latest
./install.sh mcp add linear --url https://mcp.linear.app/mcp
```

The first form registers a stdio server by spawn command; the second registers a
streamable HTTP server by URL. Use `--` when the spawn command could be mistaken
for a flag:

```bash
./install.sh mcp add playwright --agent claude -- npx -y @playwright/mcp
```

## Choosing agents

Naming agents is explicit. `--agent claude,codex` adds for exactly those and
lifts any previous deny for them; omitting `--agent` means every agent on
`PATH` and never lifts a deny. A removal writes a deny, so a later bare `add`
does not silently bring the server back.

## Logging in

```bash
./install.sh mcp auth            # every server that needs it
./install.sh mcp auth linear     # just one
```

Authentication is out of band and per agent. The installer knows which servers
have credentials and which do not; it never stores a token itself.

## Removing

```bash
./install.sh mcp remove playwright --agent codex
./install.sh mcp remove playwright --keep-catalog
```

A block this installer does not own is left alone unless you pass `--force-mcp`,
so a server you registered by hand is safe.
