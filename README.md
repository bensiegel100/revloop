# Revloop

Revloop adds persistent code-review threads to native VS Code diffs and exposes those threads to compatible coding harnesses through an Agent Plugins bundle.

## Repository layout

```text
vscode/  VS Code extension
mcp/     Local stdio MCP server
shared/  Shared thread, storage, and repository primitives
fuzz/    Shared fast-check helpers and property-based test suites
plugin/  Portable Agent Plugins bundle with MCP configuration and skill
```

The repository uses npm workspaces and Turborepo.

## Installation

### VS Code extension

Install
[Revloop from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=bensiegel.revloop)
or run:

```bash
code --install-extension bensiegel.revloop
```

Open the **Revloop** activity-bar view after installation.

### Agent plugin

The extension works independently for manual review. To let GitHub Copilot CLI
read comments and append replies, install the companion plugin:

```bash
copilot plugin marketplace add bensiegel100/revloop
copilot plugin install revloop@revloop
```

Restart Copilot CLI after the first installation. The plugin follows Agent
Plugins 1.0 and contributes:

- MCP tools `read_comments` and `reply_to_comment`;
- the `/review-comments` skill.

## Review workflow

1. In VS Code, choose **Review Working Tree** or **Review Branch Against Base**.
2. Select a changed file to open its native diff.
3. Add feedback on modified lines using VS Code's native comment controls.
4. In a compatible harness, invoke the review skill. With Copilot CLI:

   ```text
   /review-comments
   ```

5. Review the agent replies in VS Code and resolve threads when satisfied.

Only the user can resolve or reopen a thread.

## Development

Development requires Node.js 22.22.1 or later.

```bash
npm install
npm run build
npm run check
```

Useful commands:

```bash
npm run test:extension
npm run test:mcp
npm run test:plugin
npm run test:integration
npm run test:fuzz
npm run package:vscode
```

Install development builds locally with:

```bash
npm run install:vscode
npm run install:plugin
```

The MCP server requires Node.js 20 or later on `PATH`.

See [RELEASING.md](RELEASING.md) for the release process.
