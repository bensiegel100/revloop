# Revloop: Implementation Plan

This document translates the [product requirements](./revloop-prd.md) into the implemented monorepo architecture.

## Repository Layout

```text
vscode/  VS Code extension
mcp/     Local stdio MCP server
shared/  Shared domain and persistence library
plugin/  Portable Agent Plugins bundle
scripts/ Plugin assembly and validation
```

npm workspaces provide dependency linking. Turborepo orchestrates build, type-check, lint, test, and clean tasks.

## `shared`

The shared package owns invariants required by both runtime components:

- thread, message, anchor, range, and review-source types;
- thread creation, replies, resolution, reopening, and outdated transitions;
- repository-relative path validation;
- repository identity and Git-common-directory storage location;
- schema-versioned JSON validation;
- optimistic revisions and atomic file replacement.

Review state is stored outside the worktree under:

```text
<git-common-dir>/revloop/branches/<sha256-full-branch-name>.json
```

This location is accessible to both VS Code and a harness-launched MCP server, remains local, and works across linked worktrees. The extension migrates existing data from its former VS Code global-storage location on first load. Both consumers automatically remove branch-state JSON files whose local branch refs no longer exist.

## `vscode`

The extension owns editor-specific behavior:

- repository and worktree discovery through the built-in Git extension and Git CLI fallbacks;
- working-tree and merge-base review snapshots;
- native VS Code diff editors;
- modified-line commenting ranges;
- native comment conversations;
- review sidebar and user-only resolution;
- anchor tracking and confidence-based remapping;
- read-only historical documents for orphaned or deleted-file threads;
- polling for external store revisions so MCP replies appear inline.

It does not configure or launch Copilot. Installing the extension only installs the editor experience.

## `mcp`

The MCP package bundles one Node.js stdio server. The review skill determines the active Git root and passes it explicitly to each tool:

1. resolve the Git repository root from the tool argument;
2. resolve the Git common directory;
3. derive repository identity and local storage path;
4. resolve the currently checked-out branch for every tool call.

### `read_comments`

Returns review threads with:

- ID and status;
- repository-relative file and language;
- current and original ranges;
- selected excerpt and diff context;
- complete conversation and anchor history.

Inputs:

- `repositoryRoot`: absolute current Git repository root;
- `status`: `open`, `outdated`, `resolved`, `unresolved`, or `all`; `unresolved` combines open and outdated threads;
- `filePath`: optional repository-relative filter.

### `reply_to_comment`

Appends one agent-authored reply with an optional outcome:

- `changed`;
- `answered`;
- `declined`;
- `blocked`.

The tool also receives the absolute current Git repository root.

The tool cannot resolve, reopen, delete, or move threads.

## `plugin`

The Agent Plugins 1.0 package is installed as **`revloop`** and contains:

```text
plugin/
├── plugin.json
├── mcp.json
├── server/
│   └── mcp-server.cjs
└── skills/
    └── review-comments/
        └── SKILL.md
```

`mcp.json` launches the bundled server with:

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["${PLUGIN_ROOT}/server/mcp-server.cjs"]
}
```

The MCP process can launch from the plugin cache because the skill passes the active repository root to each tool.

The `/review-comments` skill:

1. fetches open comments;
2. inspects and addresses each thread;
3. runs focused validation for changes;
4. replies exactly once per handled thread;
5. never resolves threads.

## Build Graph

```text
shared
   ├──> vscode
   └──> mcp ──> plugin
```

Turbo caches package outputs:

- `shared/dist/**`;
- `vscode/dist/**`;
- `mcp/dist/**`;
- `plugin/server/**`.

The plugin build copies the bundled MCP server into the plugin directory so repository-subdirectory installation is self-contained.

## User Setup

1. Install the VS Code extension:

   ```bash
   npm run install:vscode
   ```

2. Install the agent plugin locally:

   ```bash
   npm run install:plugin
   ```

   Once hosted on GitHub, register the repository marketplace and install the plugin:

   ```bash
   copilot plugin marketplace add OWNER/REPOSITORY
   copilot plugin install revloop@revloop
   ```

3. Restart the harness and invoke:

   ```text
   /review-comments
   ```

## Validation

- shared domain and migration unit tests;
- Git, diff, anchor, and extension-state unit tests;
- MCP repository tests;
- MCP protocol smoke test against a temporary Git repository;
- VS Code extension-host activation test;
- plugin manifest, skill, MCP discovery, and local plugin tests;
- platform VSIX packaging on macOS, Linux, and Windows.

## Remaining Risks

- Node.js 20 or later must be available on `PATH` for the plugin MCP server.
- Copilot caches installed plugins; local plugin changes require reinstalling the plugin.
- Multiple writers can still conflict after the bounded optimistic retry and must surface an explicit error.
- Anchor mapping must prefer `Outdated` over a plausible but incorrect attachment.
