# Changelog

## 0.1.1

### Fixed

- Added migration instructions for uninstalling the pre-Marketplace
  `revloop.revloop` build before installing `bensiegel.revloop`.
- Retry transient Windows file-operation failures while persisting shared
  review state.

## 0.1.0

Initial Preview release.

### Added

- Working-tree reviews against the current `HEAD`.
- Branch reviews against the merge base of a selected base branch.
- Native VS Code diff navigation with persistent inline review threads.
- Editing, replying to, resolving, and reopening user-authored feedback.
- Branch-scoped review storage shared across VS Code, linked worktrees, and
  local agent processes.
- Anchor remapping that preserves outdated threads and their original context.
- Optional Agent Plugins integration for reading comments and appending agent
  replies.
