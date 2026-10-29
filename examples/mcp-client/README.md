# MCP client example

This manifest is for Claude Desktop, Cursor, OpenCode, or any other MCP client. It requests no scopes by default; grant tags explicitly with `--scope`.

The MCP server is a stdio bridge. Keep the local UOMP HTTP server running:

```bash
# Terminal 1
uomp serve

# Terminal 2
uomp authorize ./examples/mcp-client \
  --scope notes/projects \
  --output ~/.uomp/mcp-client.env \
  --no-server

uomp mcp --session ~/.uomp/mcp-client.env --print-config
```

Paste the generated JSON into the client's `mcpServers` config, then restart the client.

Tools:

- `list_memory` — keys and metadata for a tag.
- `search_memory` — keys and metadata matching text within a tag.
- `read_memory` — full item content for one key.

Re-running `uomp authorize` to the same `--output` file updates the token; the MCP server re-reads the file before each tool call.
