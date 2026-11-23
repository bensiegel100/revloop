# VS Code Marketplace launch

## 1. Lock the public identity

- [x] Create the `bensiegel` publisher in the
      [Marketplace publisher portal](https://marketplace.visualstudio.com/manage)
      under Ben's account. Publisher IDs cannot be changed.
- [x] Defer publisher recovery and backup ownership for now.
- [x] Confirm the permanent extension identity (`bensiegel.revloop`) before the
      first publish. Removed extension names cannot be reused.
- [x] Publish the first release as `0.1.0` and mark the Marketplace listing as
      Preview.
- [x] Create the public
      [`bensiegel100/revloop`](https://github.com/bensiegel100/revloop)
      repository, add it as `origin`, and push `main`.
- [x] Support VS Code `^1.101.0`, the first release line with a Node 22
      extension host. The extension's API surface is compatible with this
      minimum.

## 2. Build the Marketplace listing

- [x] Add a branded 256x256 PNG Marketplace icon while keeping
      `vscode/media/revloop.svg` as the activity-bar icon.
- [x] Add an indigo Marketplace gallery banner matching the extension icon.
- [x] Rewrite `vscode/README.md` for Marketplace users:
  - [x] Explain the problem Revloop solves and its primary workflows.
  - [x] Add screenshots using HTTPS-hosted PNG images.
  - [x] Document installation and a first-review quick start.
  - [x] Explain working-tree and branch reviews.
  - [x] Explain the optional companion agent plugin and how to install it.
  - [x] Document storage, network access, telemetry/privacy, and workspace trust.
  - [x] Document known limitations and where to get support.
- [x] Add `vscode/CHANGELOG.md` with the initial `0.1.0` Preview release notes.
- [x] Point the extension's repository, homepage, bugs, and Q&A metadata at
      `bensiegel100/revloop`.
- [x] Reference the packaged `LICENSE.md` from the extension manifest.
- [x] Tune the description, categories, and search keywords for local code
      review, coding agents, Git diffs, inline comments, and MCP.
- [x] Add structured bug and feature-request forms plus security and support
      policies.

## 3. Make releases repeatable

- [x] Remove `--allow-missing-repository` after repository metadata is present.
- [x] Derive the VSIX filename and CI artifact paths from the manifest version
      instead of hard-coding `0.0.1`.
- [x] Add a root `publish:vscode` script that publishes from the `vscode`
      workspace.
- [x] Add a dedicated tag/manual GitHub Actions release workflow that:
  - [x] Runs the complete release gate.
  - [x] Packages and publishes the extension once, outside the OS test matrix.
  - [x] Uses `contents: read` and `id-token: write` for Marketplace publishing.
  - [x] Attaches the VSIX and checksum to a GitHub release.
- [ ] Configure Visual Studio Marketplace Trusted Publishing for that workflow
      and use `vsce publish --oidc`.
- [x] Do not build a PAT-based publishing workflow. Global Azure DevOps PATs
      retire on December 1, 2026.
- [x] Protect publishing with a GitHub environment and required approval.
- [x] Document the versioning, changelog, tagging, and rollback procedure.

## 4. Validate a release candidate

- [x] Produce a valid VSIX. The `0.1.0` package audit contains 10 archive files
      and is 69.97 KB.
- [x] Include the extension license in the VSIX.
- [x] Package successfully in CI on Linux, macOS, and Windows.
- [x] Run the full release gate:
  - [x] `npm ci`
  - [x] `npm run check`
  - [x] `npm run test:extension`
  - [x] `npm run test:plugin`
  - [x] `npm run test:fuzz`
  - [x] `npm run package:vscode`
- [x] Inspect the final package with `vsce ls` and confirm it contains no source,
      tests, secrets, absolute local paths, or unnecessary development files.
- [x] Install the packaged VSIX into a clean VS Code profile and smoke-test:
  - [x] Working-tree review.
  - [x] Branch review against a selected base.
  - [x] Adding, editing, replying to, resolving, and reopening threads through
        clean-profile UI smoke coverage and the release-gate suites.
  - [x] State persistence across reloads.
  - [x] Renamed, deleted, and outdated anchors through integration and fuzz
        coverage.
  - [x] Linked worktrees and a clean-profile repository without `origin` or
        `main`.
  - [x] Companion agent plugin reading and replying to comments against the
        clean-profile review state.
- [ ] Verify the Marketplace rendering, links, screenshots, icon, README, and
      changelog before making the listing public.

## 5. Publish and verify

- [x] Bump the extension to `0.1.0` and finalize the changelog.
- [ ] Publish through the trusted GitHub workflow, or manually upload the first
      VSIX through the publisher portal.
- [ ] Install `bensiegel.revloop` from the public Marketplace into a clean profile
      and repeat the critical smoke test.
- [ ] Create the matching Git tag and GitHub release.
- [x] Update the root README to lead with Marketplace installation rather than
      local development installation.
- [x] Publish companion agent-plugin installation instructions using the stable
      `bensiegel100/revloop` marketplace URL.
- [ ] If the release must be withdrawn, unpublish it; do not remove it unless
      permanently abandoning the extension identity.

## 6. Post-launch

- [ ] Monitor Marketplace acquisition reports, ratings, reviews, and repository
      issues during the first week.
- [ ] Define response targets and a patch-release cadence for launch regressions.
- [ ] Test upcoming VS Code Stable and Insiders releases.
- [ ] Apply for verified-publisher status after the publisher and its domain meet
      the six-month eligibility requirement.

References:

- [Publishing VS Code extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest)

# Existing engineering backlog

- [x] in revloop tree, render folder hierarchy
- [x] configure strict eslint and prettier rules
  - [x] is there a vscode extension eslint plugin?
- [x] pre-commit hooks
  - [x] lint
  - [x] format
  - [x] test
- [x] configure test coverage reporting
  - require > 90% in pre-commit hook
- [x] vscode integration testing
- [x] enter-to-reply doesn't work. remove it.
- [x] implement fuzzer
- [x] threads beneath files
- [x] output too large to read at once. how do we make it smaller?
- [ ] are there faster rust-based package managers we can use?
  - perform after initial "release" (mvp complete, merged to main)
  - do before/after benchmark
  - actually no need for this.
- [ ] extension.js is large
  - perform after initial "release" (mvp complete, merged to main)
  - do before/after comparison
