# PRD: Agent Review Threads for VS Code

## 1. Executive Summary

### Problem Statement

Developers reviewing agent-written code must choose between a capable code-review environment and a conversational agent workflow. VS Code provides high-quality diffs, syntax highlighting, navigation, and language intelligence, but it does not provide a complete way to collect inline review threads and dispatch them to a selected GitHub Copilot CLI session.

### Proposed Solution

Build a local-first VS Code extension that lets a developer review working-tree or branch changes, attach persistent threads to selected modified code, and send a lightweight instruction to a new or resumed Copilot SDK session. The agent fetches open threads through local tools, changes code where appropriate, and replies to every thread; only the developer can resolve a thread.

### Success Criteria

- A developer can annotate and dispatch feedback for a 10-file change set in under 10 minutes.
- Every thread exposed to the agent includes the correct repository-relative file, current line range, selected excerpt, and relevant diff context.
- At least 95% of thread anchors remain attached after common edits above or within the selected range; uncertain anchors are marked outdated rather than silently moved.
- Every dispatched open thread receives an agent reply or an explicit delivery failure before the run is considered complete.
- The MVP works in VS Code Desktop on macOS, Linux, and Windows without uploading review data to a product-owned service.

## 2. User Experience & Functionality

### User Personas

#### Primary: Individual developer reviewing local agent changes

The primary user delegates implementation work to GitHub Copilot CLI, then reviews the resulting local changes before accepting or continuing the work. They prefer VS Code for code comprehension and want review feedback to remain attached to code rather than becoming an unstructured terminal prompt.

#### Secondary: Developer managing several Copilot sessions

The secondary user has multiple recent sessions and needs to continue the correct conversation without manually reconstructing context or copying a large review into a terminal.

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
- Branches do not inherit another branch's threads automatically in the MVP.

#### Story 5: Dispatch open threads to a selected Copilot session

As a developer, I want to select a recent session or create a new one so that the review continues in the correct Copilot conversation.

**Acceptance Criteria**

- The session picker supports:
  - creating a new persisted Copilot SDK session;
  - resuming a session by ID;
  - selecting from recent sessions when a supported session-listing API is available.
- Recent sessions are prioritized by current repository, branch, and last-used time.
- The extension creates or resumes the SDK session with the repository root as its working directory.
- Dispatch sends a short instruction telling the agent to fetch and address the open review threads.
- The full review payload is fetched through tools rather than embedded in the initial prompt.
- After creating or resuming a session, the UI shows a copyable command:

  ```text
  copilot --resume <session-id>
  ```

- The UI explains when the command can be used if the SDK session is still running.

#### Story 6: Require an agent response for every thread

As a developer, I want the agent to reply to every thread it considers so that I know whether it changed the code, answered a question, disagreed, or could not act.

**Acceptance Criteria**

- The agent can list open threads and read their full conversations.
- The agent can reply to a thread but cannot resolve, delete, or move it.
- The dispatch instruction requires one reply per open thread, including non-actionable questions.
- When the agent becomes idle, the extension checks whether every dispatched thread received a new agent reply.
- If replies are missing, the extension sends one bounded follow-up listing the missing thread IDs.
- Remaining omissions are surfaced as delivery failures in the review sidebar.

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

Each created or resumed Copilot SDK session receives local review tools scoped to one repository and branch:

- `list_review_threads`
  - Returns open and outdated threads, their IDs, file paths, current ranges, excerpts, diff context, and latest replies.
- `get_review_thread`
  - Returns the complete conversation and anchor history for one thread.
- `reply_to_review_thread`
  - Appends an agent-authored reply to one thread.

The agent must not receive tools that resolve or delete threads. Tool requests must include an unguessable workspace capability token or remain in-process so another local process cannot modify review data.

The default dispatch instruction is conceptually:

> Review every open thread for this repository and branch. Make code changes where appropriate. Use the review tools to reply to every thread, including questions and requests you cannot complete. Do not resolve threads.

### Evaluation Strategy

#### Tool-contract evaluation

- Create fixtures containing actionable requests, questions, disagreements, and impossible requests.
- Require a reply for every fetched thread.
- Verify that agent replies are attributed to the correct thread and cannot mutate user-only fields.

#### Context-integrity evaluation

- Test single-line and multi-line comments across renamed symbols, inserted lines, formatting changes, and file edits.
- Verify exact file, range, excerpt, and diff-hunk association before dispatch.
- Mark ambiguous mappings outdated instead of associating them with unrelated code.

#### Session evaluation

- Create a new session, resume it by ID, dispatch review work, and verify persisted conversation continuity.
- Confirm that the displayed `copilot --resume <session-id>` command opens the expected session after the SDK run releases it.
- Validate repository and branch ranking for recent sessions when session enumeration is supported.

#### Cross-platform evaluation

- Run end-to-end extension tests on current supported versions of macOS, Ubuntu, and Windows.
- Verify path normalization, Git behavior, local storage, and SDK startup on each platform.

## 4. Technical Specifications

### Architecture Overview

The MVP consists of four local components:

1. **VS Code extension UI**
   - Starts reviews, opens native diffs, creates threads, renders conversations, and manages resolution.
2. **Local thread store**
   - Persists branch-scoped threads, replies, anchors, dispatch history, and session IDs in VS Code workspace storage or a local database.
3. **Review tool service**
   - Exposes thread-reading and reply tools only to the selected Copilot SDK session.
4. **Copilot session coordinator**
   - Creates or resumes a persisted session, registers review tools, sends the review nudge, observes completion, validates replies, and disconnects cleanly.

```text
VS Code diff and comments
          |
          v
 Local branch thread store <---- Review tool service
          |                              ^
          v                              |
 Session picker ---> Copilot SDK session-+
                          |
                          v
                    Workspace edits
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
- creation, update, dispatch, and resolution timestamps;
- associated Copilot session IDs and dispatch attempts.

Resolution is a user-only state transition. Agent replies can record outcomes such as changed, answered, declined, or blocked without changing thread status.

### Integration Points

#### VS Code

- Comments API for inline conversation threads.
- Diff and text-editor APIs for modified-side ranges.
- Git extension API or Git CLI for working-tree and merge-base diffs.
- Workspace storage or an extension-owned local database for persistence.
- Commands, context menus, gutter actions, sidebar views, notifications, and clipboard APIs.

#### GitHub Copilot

- Copilot SDK session creation and resume by session ID.
- Persisted session IDs for later terminal continuation.
- Session events for turn completion and idle detection.
- Standard SDK permission requests surfaced to the user in VS Code.

#### Git

- Repository root, branch identity, merge base, file status, and diff hunks.
- Detached `HEAD`, bare repositories, and repositories without an initial commit are unsupported in the MVP.

### Security & Privacy

- Review data remains local except when supplied to the selected Copilot session.
- The extension must not collect source code, prompts, comments, or agent replies as telemetry.
- Any telemetry must be opt-in and limited to anonymous feature counters and timings.
- Local tool access is restricted to the active repository, branch, and dispatch.
- Tool arguments are validated against path traversal and cross-workspace access.
- Copilot permissions remain user-controlled; the extension does not silently approve destructive shell commands or external network access.
- Stored review data must not include Copilot credentials or access tokens.

## 5. Risks & Roadmap

### Phased Rollout

#### MVP: Complete the local review loop

- Working-tree and branch-diff review sources.
- Modified-side inline threads and review sidebar.
- Branch-scoped local persistence and basic anchor remapping.
- New and resumed Copilot SDK sessions.
- Local list, read, and reply tools.
- Mandatory per-thread agent responses.
- User-only thread resolution.
- Copyable terminal resume command.

#### v1.1: Make repeated review cycles faster

- Selective dispatch by file or thread.
- Better anchor remapping across larger refactors and file renames.
- Reviewed-file progress and stale-review indicators.
- Session search by name, ID prefix, branch, and last-used time.
- A compact view of changes made since the user's previous review.

#### v2.0: Expand interoperability

- GitHub pull-request review synchronization.
- Team-shared review state.
- Additional CLI agents through adapters.
- Live bridges to already-running external terminal sessions.
- Additional editors through a reusable review-thread protocol.

### Technical Risks

#### Recent-session discovery may lack a stable public API

The SDK can create and resume sessions by ID, but recent-session enumeration must be validated against a supported API. If no stable API exists, the MVP will list sessions previously used by the extension and accept manually entered session IDs.

#### Concurrent clients may contend for one persisted session

Opening `copilot --resume <session-id>` while the SDK owns that session may fail or produce conflicting activity. The extension must release the session after the dispatched turn and clearly indicate when terminal resume is safe.

#### Code edits can invalidate anchors

Agent changes may replace or move the selected code. Anchor remapping must use range tracking plus content fingerprints and must prefer an explicit `Outdated` state over an incorrect attachment.

#### Agents may omit required replies

Prompt instructions alone are not sufficient. The coordinator must verify tool usage, issue one bounded follow-up for missing replies, and expose any remaining omissions rather than implying success.

#### Resumed sessions may not retain extension tools automatically

Every resume operation must re-register the local review tools and validate tool availability before dispatch.

#### Local IPC can expose review data

If tools use a loopback server or socket, the service must bind locally, use per-dispatch capability tokens, reject requests from other workspaces, and shut down when the session disconnects.

### Assumptions Requiring Prototype Validation

- Copilot SDK sessions can edit the current workspace while permission requests are presented coherently in VS Code.
- A resumed SDK session can be released and subsequently opened with `copilot --resume <session-id>` without state loss.
- VS Code's Comments API provides sufficient control for branch-persistent, user-resolved threaded conversations on the modified side of native diffs.
