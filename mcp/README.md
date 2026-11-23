# Revloop MCP server

This package builds the local stdio MCP server used by the Revloop Copilot plugin.

The server derives repository identity and review storage from its Git working directory and exposes:

- `read_comments`;
- `reply_to_comment`.

Build and run its protocol smoke test from the monorepo root:

```bash
npm run test:mcp
```
