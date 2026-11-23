# PRD: Revloop for VS Code

## 1. Executive Summary

### Problem Statement

Developers reviewing agent-written code must choose between a capable code-review environment and a conversational agent workflow. VS Code provides high-quality diffs, syntax highlighting, navigation, and language intelligence, but it does not provide a complete way to collect inline review threads and expose them to the GitHub Copilot CLI session already doing the work.

### Proposed Solution

Build a local-first VS Code extension that lets a developer review working-tree or branch changes, attach persistent threads to selected modified code, and expose those threads through a repository-scoped MCP server. The current agent fetches open threads, changes code where appropriate, and replies with what it changed; only the developer can resolve a thread.

### Success Criteria

- A developer can annotate feedback for a 10-file change set in under 10 minutes.
- Every thread exposed to the agent includes the correct repository-relative file, current line range, selected excerpt, and relevant diff context.
- At least 95% of thread anchors remain attached after common edits above or within the selected range; uncertain anchors are marked outdated rather than silently moved.
- The current Copilot CLI session can read only open threads by default and append an agent reply to any thread.
- The MVP works in VS Code Desktop on macOS, Linux, and Windows without uploading review data to a product-owned service.

## 2. User Experience & Functionality

### User Personas

#### Primary: Individual developer reviewing local agent changes

The primary user delegates implementation work to GitHub Copilot CLI, then reviews the resulting local changes before accepting or continuing the work. They prefer VS Code for code comprehension and want review feedback to remain attached to code rather than becoming an unstructured terminal prompt.

#### Secondary: Developer continuing an existing Copilot session

The secondary user wants the agent already working in the repository to retrieve structured review feedback without starting another session or copying comments into a terminal.

### User Stories

#### Story 1: Start a review from local changes

As a developer, I want to review either uncommitted changes or my branch relative to a selected base branch so that I can inspect the complete change produced by an agent.

**Acceptance Criteria**

- The extension offers `Working Tree` and `Branch Diff` review sources.
- A working-tree review compares the current workspace against `HEAD`.
- A branch review compares the current branch against the merge base of a selected base branch.
- Changed files are listed by status and open in VS Code's native diff editor.
- The modified side remains a normal VS Code editor with syntax highlighting, hover documentation, navigation, and language features.

#### Story 2: Attach a review thread to modified code

As a developer, I want to select one or more lines and add a comment so that my feedback remains anchored to the code under review.

**Acceptance Criteria**

- A context-menu action and gutter action create a thread on the selected modified lines.
- With no selection, the current modified line is used.
- The thread records the repository-relative path, current range, selected excerpt, source language, and relevant diff hunk.
- MVP comments can be created only on the current modified side of a diff.
- Threads appear inline and in a review sidebar grouped by file.

#### Story 3: Continue a conversation on each issue

As a developer, I want each review item to behave as a conversation so that questions and requested changes can be discussed without losing their code context.

**Acceptance Criteria**

- A thread contains the original user comment and ordered replies from the user and agent.
- The user can add another reply at any time.
- Agent replies are visually distinguished from user replies.
- Questions are treated as valid threads even when no code change is requested.
- Only the user can resolve or reopen a thread.
- Sending feedback or receiving an agent reply never resolves a thread automatically.

#### Story 4: Preserve review state for the branch

As a developer, I want threads to survive edits, commits, reloads, and session changes for the lifetime of the branch so that review work is not lost.

**Acceptance Criteria**

- Threads are stored locally and keyed by repository identity and full branch name.
- Switching branches hides the current branch's threads and restores the destination branch's threads.
- Threads survive VS Code reloads and commits on the same branch.
- Thread anchors track code movement when the mapping is unambiguous.
- When a range cannot be mapped confidently, the thread is marked `Outdated` and retains its original excerpt and location.
- Outdated threads remain clickable and open a read-only historical document containing their original diff context and conversation.
- Branches do not inherit another branch's threads automatically in the MVP.

#### Story 5: Expose threads to the current Copilot session

As a developer, I want the current Copilot CLI session to read my open review threads so that the review continues in the existing conversation.

**Acceptance Criteria**

- A separately installed Agent Plugins bundle provides the local stdio MCP server and review skill.
- The MCP server derives repository scope from the CLI session's working directory and resolves the currently checked-out branch for every tool call.
- The plugin exposes an invokable `/review-comments` skill.
- The full review payload is fetched through MCP tools rather than embedded in the user's prompt.

#### Story 6: Require an agent response for every thread

As a developer, I want the agent to reply to every thread it considers so that I know whether it changed the code, answered a question, disagreed, or could not act.

**Acceptance Criteria**

- The agent can list open threads and read their full conversations.
- The agent can reply to a thread but cannot resolve, delete, or move it.
- The recommended agent instruction requires one reply per open thread, including non-actionable questions.
- Agent replies record whether the request was changed, answered, declined, or blocked.
- MCP replies never resolve, reopen, delete, or move a thread.

### Non-Goals

- Synchronizing comments with GitHub pull-request reviews.
- Multi-user or team collaboration.
- Supporting Claude Code, Codex CLI, or generic terminal agents.
- Commenting directly on deleted or base-side lines.
- Allowing an agent to resolve review threads.
- Generating autonomous review findings.
- Storing source code or review comments in a product-owned cloud service.
- Supporting VS Code Web, JetBrains IDEs, or other editors in the MVP.
- Automatically committing, merging, or approving changes.

## 3. AI System Requirements

### Tool Requirements

Revloop exposes local MCP tools scoped to one repository and the currently checked-out branch:

- `read_comments`
  - Returns threads with their IDs, statuses, file paths, current ranges, excerpts, diff context, conversations, and anchor history.
  - Accepts the current repository root and supports status and file-path filtering, including `Unresolved` for open and outdated threads.
- `reply_to_comment`
  - Accepts the current repository root and appends an agent-authored reply to one thread.

The agent must not receive tools that resolve or delete threads. The local server uses stdio rather than a listening network endpoint and derives repository and storage scope from Git.

The recommended agent instruction is:

> Read all open Revloop comments, address each one, and reply to every comment with what changed. Do not resolve threads.

### Evaluation Strategy

#### Tool-contract evaluation

- Create fixtures containing actionable requests, questions, disagreements, and impossible requests.
- Require a reply for every fetched thread.
- Verify that agent replies are attributed to the correct thread and cannot mutate user-only fields.

#### Context-integrity evaluation

- Test single-line and multi-line comments across renamed symbols, inserted lines, formatting changes, and file edits.
- Verify exact file, range, excerpt, and diff-hunk association in MCP results.
- Mark ambiguous mappings outdated instead of associating them with unrelated code.

#### MCP evaluation

- Install the `revloop` plugin and verify its skill and MCP server are discovered.
- Invoke `/review-comments` and verify `read_comments` and `reply_to_comment`.
- Switch branches and verify the same MCP server reads the destination branch's review state.

#### Cross-platform evaluation

- Run end-to-end extension tests on current supported versions of macOS, Ubuntu, and Windows.
- Verify path normalization, Git behavior, repository-local storage, MCP process startup, and plugin installation on each platform.

## 4. Technical Specifications

### Architecture Overview

The MVP consists of four local components:

1. **VS Code extension UI**
   - Starts reviews, opens native diffs, creates threads, renders conversations, and manages resolution.
2. **Local thread store**
   - Persists branch-scoped threads, replies, and anchors under the repository's Git common directory so VS Code and MCP share one local source of truth.
3. **Revloop MCP server**
   - Runs over stdio when launched by Copilot CLI and exposes read and reply tools.
4. **Agent plugin**
   - Bundles the MCP server configuration, server artifact, and `/review-comments` skill.

```text
VS Code diff and comments
          |
          v
Local branch thread store <---- Revloop MCP server <---- Current Copilot CLI session
         ^                                                   |
         |___________________________________________________|
                          agent replies
```

### Thread Data Model

Each thread contains:

- stable thread ID;
- repository identity and full branch name;
- repository-relative file path;
- current range and original range;
- selected excerpt and surrounding diff hunk;
- anchor fingerprint used for remapping;
- status: `Open`, `Outdated`, or `Resolved`;
- ordered user and agent messages;
- creation, update, and resolution timestamps.

Resolution is a user-only state transition. Agent replies can record outcomes such as changed, answered, declined, or blocked without changing thread status.

### Integration Points

#### VS Code

- Comments API for inline conversation threads.
- Diff and text-editor APIs for modified-side ranges.
- Git extension API or Git CLI for working-tree and merge-base diffs.
- Extension-owned local JSON storage for persistence.
- Commands, context menus, gutter actions, sidebar views, notifications, and clipboard APIs.

#### GitHub Copilot

- Agent Plugins 1.0 manifest, skill, and MCP configuration.
- Local stdio server launch inherited from the CLI session's repository working directory.

#### Git

- Repository root, branch identity, merge base, file status, and diff hunks.
- Detached `HEAD`, bare repositories, and repositories without an initial commit are unsupported in the MVP.

### Security & Privacy

- Review data remains local except when returned to the current Copilot session through MCP.
- The extension must not collect source code, prompts, comments, or agent replies as telemetry.
- Any telemetry must be opt-in and limited to anonymous feature counters and timings.
- Local tool access is restricted to the CLI working repository and currently checked-out branch.
- Tool arguments are validated against path traversal and cross-workspace access.
- Copilot permissions remain user-controlled; Revloop does not approve shell commands or external network access.
- Stored review data must not include Copilot credentials or access tokens.

## 5. Risks & Roadmap

### Phased Rollout

#### MVP: Complete the local review loop

- Working-tree and branch-diff review sources.
- Modified-side inline threads and review sidebar.
- Branch-scoped local persistence and basic anchor remapping.
- Bundled local stdio MCP server.
- Open-thread filtering and agent replies through MCP.
- Installable portable `revloop` agent plugin.
- Invokable `/review-comments` skill.
- User-only thread resolution.

#### v1.1: Make repeated review cycles faster

- Additional MCP filters and batch reply workflows.
- Better anchor remapping across larger refactors and file renames.
- Reviewed-file progress and stale-review indicators.
- A compact view of changes made since the user's previous review.

#### v2.0: Expand interoperability

- GitHub pull-request review synchronization.
- Team-shared review state.
- Additional MCP-capable agents through adapters.
- Additional editors through a reusable review-thread protocol.

### Technical Risks

#### Copilot caches installed plugins

After installing or updating the local plugin, the user must start a session that loads the refreshed plugin cache.

#### Code edits can invalidate anchors

Agent changes may replace or move the selected code. Anchor remapping must use range tracking plus content fingerprints and must prefer an explicit `Outdated` state over an incorrect attachment.

#### Concurrent extension and MCP writes can conflict

The extension and MCP process share revisioned local JSON state. Writes must use optimistic concurrency and retry bounded conflicts, while the extension watches for external revisions.

#### The MCP server requires Node.js

The plugin launches a bundled JavaScript server with `node`; Node.js 20 or later must be available on `PATH`.

### Assumptions Requiring Prototype Validation

- Copilot CLI can install the `revloop` plugin from the repository subdirectory.
- Plugin installation exposes both the MCP tools and `/review-comments` skill.
- VS Code's Comments API provides sufficient control for branch-persistent, user-resolved threaded conversations on the modified side of native diffs.
