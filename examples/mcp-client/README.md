# MCP client example

This manifest is for Claude Desktop, Cursor, OpenCode, or any other MCP client. It requests no scopes by default; grant tags explicitly with `--scope`.

## One command

```bash
uomp connect claude --scope notes/projects
```

If your Markdown vault is not imported yet, add `--vault`:

```bash
uomp connect claude --vault ~/Obsidian/MyVault --scope notes/projects
```

`uomp connect` starts the local server in the background, creates a scoped session, writes the session env file, and merges the UOMP entry into the client config. Restart the client, then ask it to list notes under `notes/projects`.

Use `uomp connect cursor` or `uomp connect opencode` for the other clients. Re-run the same command to renew; the client does not need a restart. `uomp status` shows the server and sessions; `uomp stop` stops the server; `uomp disconnect <client>` removes the config entry and revokes the session.

## On-demand consent

Add `--on-demand` to defer authorization until the first tool call:

```bash
uomp connect claude --vault ~/Obsidian/MyVault --scope notes/projects --on-demand
```

The first tool call opens a local approval page. If the page does not open, use `uomp pending` and `uomp approve <request-id>`; `uomp deny <request-id>` closes the request without granting access.

## Manual setup

For an unsupported client, or to edit the config yourself:

```bash
# Terminal 1
uomp serve

# Terminal 2
uomp authorize \
  --scope notes/projects \
  --output ~/.uomp/mcp-client.env \
  --no-server

uomp mcp --session ~/.uomp/mcp-client.env --print-config --client claude
```

Paste the generated JSON into the client's `mcpServers` entry. Use `--client cursor` or `--client opencode` for those shapes; without `--client`, the output is the generic `mcpServers` shape.

Tools:

- `list_memory` — keys and metadata for a tag.
- `search_memory` — keys and metadata matching text within a tag.
- `read_memory` — full item content for one key.

Re-running `uomp authorize` to the same `--output` file updates the token; the MCP server re-reads the file before each tool call.
