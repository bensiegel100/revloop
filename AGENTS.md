# Revloop repository instructions

## Toolchain and commands

This is an npm-workspaces monorepo orchestrated by Turborepo. Development and
CI require Node.js 22.22.1 or later. Keep the bundled MCP server compatible
with Node.js 20 or later. The repository uses TypeScript 6.

Run commands from the repository root:

```bash
npm ci
npm run build
npm run check
```

`npm run check` runs formatting checks, lint, type checking, unit tests, builds,
and the MCP protocol smoke test. It does not run the VS Code extension-host,
Agent Plugin integration, or fuzz tests:

```bash
npm run test:extension
npm run test:mcp
npm run test:plugin
npm run test:integration
npm run test:fuzz
npm run package:vscode
```

Run a single Vitest file through its workspace:

```bash
npm test --workspace @revloop/shared -- test/domain/threadState.test.ts
npm test --workspace @revloop/mcp -- test/reviewRepository.test.ts
npm test --workspace revloop -- test/git/diffParser.test.ts
```

Use the validation path that matches the change:

- Shared domain, storage, or repository identity changes affect both consumers.
  Run the focused shared test, the relevant MCP or extension tests, and
  `npm run check`.
- VS Code UI, Git, manifest, or lifecycle changes require a focused `vscode`
  workspace test and `npm run test:extension`. Packaging or installation
  changes also require `npm run package:vscode`; run `npm run install:vscode`
  when the local `code` CLI is available.
- MCP protocol or repository changes require `npm run test:mcp`.
- Plugin manifest, skill, bundle, or installation changes require
  `npm run test:plugin`; installation-flow changes should also exercise
  `npm run install:plugin`.
- Do not report a runtime path as fixed or installed unless that exact path was
  exercised successfully.

Husky installs repository hooks through the root `prepare` script:

- `pre-commit` runs lint-staged with ESLint before Prettier, then type checking
  and coverage-gated unit tests. Fuzz tests are excluded from this path.
- `pre-push` runs `npm run test:integration` and `npm run test:fuzz`, covering
  the MCP protocol, VS Code extension-host, Agent Plugin integration, and
  property-based fuzz suites.

ESLint uses the type-aware TypeScript strict and stylistic presets. Additional
flat-config layers enforce import integrity with `eslint-plugin-import-x`,
Vitest test correctness with `@vitest/eslint-plugin`, Node API compatibility
with `eslint-plugin-n`, and Microsoft SDL security rules. Node checks target
Node 20 for shipped `shared` and MCP source, Node 22 for VS Code source, and the
pinned Node 22.22.1 toolchain for scripts and JavaScript test harnesses.
Extension-host and MCP smoke-test JavaScript is linted; only generated
`plugin/server/` output remains excluded.

Additional required rules include braces and strict equality, object shorthand,
object spread, explicit `parseInt` radix values, explicit exported API types,
readonly inference, full promise misuse checks, unambiguous void expressions,
exhaustive switches, strict boolean expressions, and safe type assertions.

When adding a package, check whether its maintainers publish an official ESLint
plugin or recommended lint configuration. If one exists and is compatible with
this repository's flat ESLint setup, install it and enable its recommended rules
for the relevant files.

## Architecture and ownership

- `shared/` owns framework-independent thread types, state transitions,
  repository identity, path normalization, schema validation, locking, and JSON
  persistence. Keep it free of VS Code and MCP dependencies.
- `fuzz/` owns all fast-check configuration, arbitraries, generated review
  fixtures, and fuzz suites. Keep all fuzz tests under `fuzz/test`; do not add
  package-local fuzz suites.
- `vscode/` owns the extension UI, Git integration, diff snapshots, anchor
  remapping, historical documents, and review lifecycle. Agent integration does
  not belong in the extension.
- `mcp/` owns the local stdio server and exposes only `read_comments` and
  `reply_to_comment`.
- `plugin/` is the harness-neutral Agent Plugins bundle. It packages the MCP
  server and the `review-comments` skill; do not add harness-specific naming or
  SDK coupling to its public structure.

The extension and MCP server do not communicate through a live process. They
share branch-scoped JSON state through `shared/`, stored below:

```text
<git-common-dir>/revloop/branches/
```

The extension's global storage path is retained only for legacy-state
migration. Keep current state in the Git common directory so linked worktrees
and external agent processes see the same review data.

## Git, worktrees, and review state

- Do not assume an `origin` remote or a `main` branch. Repository identity uses
  the canonical worktree root, `git rev-parse --git-common-dir`, and an optional
  origin URL.
- Preserve linked-worktree and symlink support by canonicalizing filesystem
  paths before comparing repositories or document URIs.
- Base-branch discovery combines the VS Code Git API with a Git CLI
  `for-each-ref` fallback. `main` or `master` may be preferred, but must not be
  required.
- Working-tree reviews compare against the current HEAD. Branch reviews compare
  against the merge base with the selected base branch.
- Reviews require a named branch and an initial commit. Detached HEAD and unborn
  repositories must fail explicitly rather than producing partial state.
- Branch keys use full refs such as `refs/heads/feature`. Use the shared store
  and state-transition helpers rather than editing persisted JSON directly;
  revision checks and lock directories protect cross-process writes.
- A thread whose anchor can no longer be mapped becomes `outdated`; do not
  delete it because a file was renamed, moved, or removed. Preserve its original
  anchor and diff context so the extension can open a historical document.

## Plugin and MCP contract

- `plugin/mcp.json` launches
  `${PLUGIN_ROOT}/server/mcp-server.cjs`. The server runs from an agent plugin
  cache, so its process working directory is not the reviewed repository.
- Every MCP tool call must receive an absolute `repositoryRoot`. Resolve Git
  state from that path; never infer the target repository from `process.cwd()`.
- `plugin/server/mcp-server.cjs` is an intentionally tracked generated
  artifact. Do not edit it by hand or add it to `.gitignore`.
  `scripts/build-plugin.mjs` copies it from `mcp/dist/mcp-server.cjs`; rebuild
  the plugin after MCP changes.
- `read_comments` defaults to open threads and may filter by status or file.
  `reply_to_comment` appends an agent response but never resolves, reopens,
  moves, or deletes a thread.

## User experience and authority

- Keep the user-facing name `Revloop` and the internal contribution prefix
  `revloop`.
- File and thread rows are already clickable. Do not add redundant open buttons.
- Show a file's thread count only when it is nonzero.
- Leave VS Code's native comment-editor keybindings unchanged.
- Only user-authored comments and replies are editable; agent replies are
  read-only.
- Only the user may resolve or reopen a review thread. Agents address feedback
  and reply with `changed`, `answered`, `declined`, or `blocked`; they do not
  control resolution.
