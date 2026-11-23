import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type {
  AnchorSnapshot,
  RepositoryIdentity,
  ReviewMessage,
  ReviewThread,
} from "@revloop/shared";
import type { ActiveRepository } from "../../src/git/gitService.js";
import type { ReviewFile, ReviewSnapshot } from "../../src/git/types.js";
import { RefType } from "../../src/git/vscodeGitApi.js";
import type { GitApi, Repository } from "../../src/git/vscodeGitApi.js";
import {
  createReviewFileTargets,
  ReviewController,
} from "../../src/reviewController.js";
import type { ThreadRepositoryContext } from "../../src/storage/threadRepository.js";
import { ReviewFileItem } from "../../src/ui/reviewTree.js";
import { mockState, resetVscodeMock } from "../helpers/vscodeMock.mjs";

describe("review lifecycle", () => {
  it("offers every file thread as a leaf click target", () => {
    const current = createThread("thread-1", "open", true);
    const historical = createThread("thread-2", "outdated", false);
    const targets = createReviewFileTargets({
      file: createReviewFile(),
      threads: [current, historical],
    });

    expect(targets).toHaveLength(3);
    expect(targets[0]?.file).toBeDefined();
    expect(targets.slice(1).map((target) => target.thread?.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
  });

  it("disables writes while HEAD is detached and recovers on a named branch", async () => {
    const active = createActiveRepository();
    const threads = createThreadRepository(active.identity, active.branch);
    const git = {
      initialize: vi.fn(() => Promise.resolve()),
      selectRepository: vi.fn(() => Promise.resolve(active)),
      chooseBaseBranch: vi.fn(() => Promise.resolve(undefined)),
      createWorkingTreeSource: vi.fn(() => ({
        kind: "working-tree" as const,
        baseCommit: active.headCommit,
      })),
      createBranchSource: vi.fn(() =>
        Promise.resolve({
          kind: "branch" as const,
          baseBranch: "main",
          mergeBase: "abc123",
        }),
      ),
      readCurrentHead: vi
        .fn()
        .mockRejectedValueOnce(new Error("Detached HEAD is unsupported."))
        .mockResolvedValue({
          branchName: "main",
          headCommit: "def456",
        }),
      buildSnapshot: vi.fn(
        (
          current: ActiveRepository,
          source: { kind: "working-tree"; baseCommit: string },
        ): Promise<ReviewSnapshot> =>
          Promise.resolve({
            repository: current.identity,
            branch: current.branch,
            source,
            files: [],
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
      ),
    };
    const context = { subscriptions: [] as vscode.Disposable[] };
    const controller = new ReviewController(context, git, threads, {
      createHistoricalDocument: (thread) => ({
        uri: vscode.Uri.from({
          scheme: "revloop-history",
          path: thread.filePath,
        }),
        range: new vscode.Range(0, 0, 0, 1),
      }),
    });
    await controller.initialize();
    expect(threads.openCalls).toBe(1);

    await controller.refresh();

    expect(threads.suspendCalls).toBe(2);
    await expect(controller.addThread()).rejects.toThrow(
      "Review comments are not initialized.",
    );

    await controller.refresh();

    expect(threads.openCalls).toBe(2);
    await expect(controller.addThread()).rejects.toThrow(
      "Open a modified file before adding a review thread.",
    );
    controller.dispose();
  });

  it("coordinates review commands, files, threads, and branch refreshes", async () => {
    resetVscodeMock();
    const active = createActiveRepository();
    const current = createThread("thread-1", "open", true);
    const historical = createThread("thread-2", "outdated", false);
    const threads = createThreadRepository(active.identity, active.branch, [
      current,
      historical,
    ]);
    const file = createReviewFile();
    const workingSource = {
      kind: "working-tree" as const,
      baseCommit: active.headCommit,
    };
    const git = {
      initialize: vi.fn(() => Promise.resolve()),
      selectRepository: vi.fn(() => Promise.resolve(active)),
      chooseBaseBranch: vi.fn(() => Promise.resolve("main")),
      createWorkingTreeSource: vi.fn(() => workingSource),
      createBranchSource: vi.fn(() =>
        Promise.resolve({
          kind: "branch" as const,
          baseBranch: "main",
          mergeBase: "merge-base",
        }),
      ),
      readCurrentHead: vi.fn(() =>
        Promise.resolve({
          branchName: active.branchName,
          headCommit: active.headCommit,
        }),
      ),
      buildSnapshot: vi.fn(
        (
          repository: ActiveRepository,
          source: ReviewSnapshot["source"],
        ): Promise<ReviewSnapshot> =>
          Promise.resolve({
            repository: repository.identity,
            branch: repository.branch,
            source,
            files: [file],
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
      ),
    };
    const showDocument = vi.fn(() => Promise.resolve(undefined));
    setVscodeFunction(vscode.window, "showTextDocument", showDocument);
    setVscodeFunction(vscode.workspace, "openTextDocument", () =>
      Promise.resolve({ uri: file.modifiedUri }),
    );
    const revealRange = vi.fn();
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: {
        document: { uri: file.modifiedUri },
        selection: new vscode.Selection(0, 0, 0, 0),
        revealRange,
      },
    });
    const context = { subscriptions: [] as vscode.Disposable[] };
    const controller = new ReviewController(context, git, threads, {
      createHistoricalDocument: (thread) => ({
        uri: vscode.Uri.from({
          scheme: "revloop-history",
          path: thread.filePath,
        }),
        range: new vscode.Range(0, 0, 0, 1),
      }),
    });

    await controller.initialize();
    expect(controller.getSnapshot()?.files).toHaveLength(1);
    expect(controller.getOpenThreads().map((thread) => thread.id)).toEqual([
      current.id,
    ]);

    const currentCommentThread = requireValue(mockState.commentThreads[0]);
    const userComment = requireValue(currentCommentThread.comments[0]);
    await controller.reply({
      thread: currentCommentThread,
      text: "Follow up.",
    });
    await controller.resolve(current.id);
    await controller.reopen(current.id);
    await controller.editComment(userComment);
    userComment.body = "Updated feedback.";
    await controller.saveComment(userComment);
    await controller.editComment(userComment);
    await controller.cancelCommentEdit(userComment);

    await controller.openThread(current.id);
    await controller.openThread(historical.id);
    await controller.openFile(file.path);
    await controller.openFile(new ReviewFileItem(file.path, [current], file));
    expect(revealRange).toHaveBeenCalled();
    expect(showDocument).toHaveBeenCalled();

    await controller.startBranchReview();
    await controller.refresh();
    expect(git.createBranchSource).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});

function createActiveRepository(): ActiveRepository {
  const identity = createRepositoryIdentity();
  const stateEmitter = new vscode.EventEmitter<void>();
  const repository: Repository = {
    rootUri: vscode.Uri.file(identity.rootPath),
    state: {
      HEAD: { type: RefType.Head, name: "main" },
      refs: [],
      remotes: [],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
      onDidChange: stateEmitter.event,
    },
    onDidCheckout: new vscode.EventEmitter<void>().event,
    diffWithHEAD: vi.fn(),
    diffWith: vi.fn(),
    getMergeBase: vi.fn(),
    getBranches: vi.fn(() => Promise.resolve([])),
  };
  const api: GitApi = {
    state: "initialized",
    onDidChangeState: new vscode.EventEmitter<"uninitialized" | "initialized">()
      .event,
    git: { path: "git" },
    repositories: [repository],
    onDidOpenRepository: new vscode.EventEmitter<Repository>().event,
    onDidCloseRepository: new vscode.EventEmitter<Repository>().event,
    toGitUri: (uri) => uri,
    getRepository: () => repository,
    openRepository: () => Promise.resolve(repository),
  };
  return {
    api,
    repository,
    identity,
    branchName: "main",
    branch: "refs/heads/main",
    headCommit: "abc123",
  };
}

function createThreadRepository(
  initialRepository: RepositoryIdentity,
  initialBranch: string,
  initialThreads: readonly ReviewThread[] = [],
) {
  let repository = initialRepository;
  let branch = initialBranch;
  let generation = 0;
  let active = false;
  const fallbackThread = createThread("thread-1", "open", true);
  const message = fallbackThread.messages[0];
  if (message === undefined) {
    throw new Error("Expected a review message.");
  }
  return {
    get repository() {
      return repository;
    },
    get branch() {
      return branch;
    },
    suspendCalls: 0,
    openCalls: 0,
    open(nextRepository: RepositoryIdentity, nextBranch: string) {
      this.openCalls += 1;
      generation += 1;
      repository = nextRepository;
      branch = nextBranch;
      active = true;
      return Promise.resolve({
        generation,
        repositoryKey: repository.key,
        branch,
      });
    },
    suspend(context?: ThreadRepositoryContext) {
      if (
        context !== undefined &&
        (!active ||
          context.generation !== generation ||
          context.repositoryKey !== repository.key ||
          context.branch !== branch)
      ) {
        return false;
      }
      this.suspendCalls += 1;
      generation += 1;
      active = false;
      return true;
    },
    captureContext(): ThreadRepositoryContext {
      return {
        generation,
        repositoryKey: repository.key,
        branch,
      };
    },
    isCurrent(context: ThreadRepositoryContext) {
      return (
        active &&
        context.generation === generation &&
        context.repositoryKey === repository.key &&
        context.branch === branch
      );
    },
    list: () => initialThreads,
    get: (threadId: string) =>
      initialThreads.find((thread) => thread.id === threadId),
    onDidChange: () => ({ dispose: () => undefined }),
    create: vi.fn(() => Promise.resolve(fallbackThread)),
    appendUserReply: vi.fn(() => Promise.resolve(message)),
    editUserMessage: vi.fn(
      (_threadId: string, _messageId: string, body: string) =>
        Promise.resolve({ ...message, body }),
    ),
    resolve: vi.fn(() => Promise.resolve()),
    reopen: vi.fn(() => Promise.resolve()),
    updateAnchor: () => Promise.resolve(),
    markOutdated: () => Promise.resolve(),
  };
}

function createRepositoryIdentity(): RepositoryIdentity {
  return {
    key: "repository",
    rootPath: "/workspace/repository",
    displayName: "repository",
    storageRoot: "/workspace/repository/.git/revloop",
  };
}

function createReviewFile(): ReviewFile {
  return {
    path: "src/index.ts",
    status: "modified",
    baseUri: vscode.Uri.from({ scheme: "git", path: "src/index.ts" }),
    modifiedUri: vscode.Uri.file("/workspace/repository/src/index.ts"),
    diff: {
      header: "header",
      hunks: [],
      binary: false,
    },
    canComment: true,
  };
}

function createThread(
  id: string,
  status: ReviewThread["status"],
  current: boolean,
): ReviewThread {
  const anchor: AnchorSnapshot = {
    filePath: "src/index.ts",
    range: {
      start: { line: 4, character: 0 },
      end: { line: 4, character: 1 },
    },
    selectedText: "x",
    beforeContext: [],
    afterContext: [],
    contentHash: "hash",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
  const message: ReviewMessage = {
    id: `${id}-message`,
    author: "user",
    body: current ? "Current thread." : "Historical thread.",
    createdAt: anchor.capturedAt,
  };
  return {
    id,
    repositoryKey: "repository",
    branch: "refs/heads/main",
    filePath: anchor.filePath,
    languageId: "typescript",
    status,
    originalAnchor: anchor,
    currentAnchor: current ? anchor : null,
    anchorHistory: [{ kind: "created", at: anchor.capturedAt }],
    diffContext: {
      header: "header",
      hunk: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    },
    messages: [message],
    createdAt: anchor.capturedAt,
    updatedAt: anchor.capturedAt,
  };
}

function setVscodeFunction(
  target: object,
  name: string,
  value: (...arguments_: unknown[]) => unknown,
): void {
  Object.defineProperty(target, name, {
    configurable: true,
    value,
  });
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a fixture value.");
  }
  return value;
}
