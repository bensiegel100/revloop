# Revloop agent plugin

This portable Agent Plugins 1.0 bundle includes:

- the Revloop MCP server;
- the `/review-comments` skill.

Install from the public Revloop marketplace with GitHub Copilot CLI:

```bash
copilot plugin marketplace add bensiegel100/revloop
copilot plugin install revloop@revloop
```

If `revloop` was previously registered from a local checkout, replace that
registration first:

```bash
copilot plugin marketplace remove revloop --force
copilot plugin marketplace add bensiegel100/revloop
copilot plugin install revloop@revloop
```

Verify the public installation with:

```bash
copilot plugin marketplace browse revloop
copilot plugin list
```

For development, install the current checkout from the monorepo root:

```bash
npm run install:plugin
```

Invoke the review workflow:

```text
/review-comments
```

Node.js 20 or later must be available on `PATH` for the local MCP server.
