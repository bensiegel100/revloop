# Revloop agent plugin

This portable Agent Plugins 1.0 bundle includes:

- the Revloop MCP server;
- the `/review-comments` skill.

Install locally with GitHub Copilot CLI:

```bash
npm run install:plugin
```

After the repository is pushed, install directly from its plugin subdirectory:

```bash
copilot plugin install OWNER/REPOSITORY:plugin
```

Invoke the review workflow:

```text
/review-comments
```

Node.js 20 or later must be available on `PATH` for the local MCP server.
