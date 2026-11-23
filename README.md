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

## User setup

### 1. Install the VS Code extension

From the repository root:

```bash
npm run install:vscode
```

Reload VS Code, then open the **Revloop** activity-bar view.

### 2. Install the agent plugin

```bash
npm run install:plugin
```

The installer registers this checkout as the local `revloop` marketplace and installs `revloop@revloop` without copying the plugin. With GitHub Copilot CLI, restart the CLI after first installation. The plugin follows Agent Plugins 1.0 and contributes:

- MCP tools `read_comments` and `reply_to_comment`;
- the `/review-comments` skill.

After publishing the repository, register its marketplace and install the plugin:

```bash
copilot plugin marketplace add OWNER/REPOSITORY
copilot plugin install revloop@revloop
```

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

The MCP server requires Node.js 20 or later on `PATH`.
