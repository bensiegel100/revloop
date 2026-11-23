import path from "node:path";
import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnchorSnapshot,
  NewThreadInput,
  RepositoryIdentity,
  ReviewMessage,
  ReviewThread,
} from "@revloop/shared";
import type { ReviewSnapshot } from "../../src/git/types.js";
import {
  canonicalizeReviewSnapshot,
  normalizeCommentRange,
  reconcileReviewComments,
  ReviewComments,
} from "../../src/ui/comments.js";
import type { ReviewCommentsRepository } from "../../src/ui/comments.js";
import { mockState, resetVscodeMock } from "../helpers/vscodeMock.mjs";

beforeEach(() => {
  resetVscodeMock();
});

describe("review comments", () => {
  it("edits and persists user-authored comments", async () => {
    const message = createMessage();
    const editUserMessage = vi.fn(
      (_threadId: string, _messageId: string, body: string) =>
        Promise.resolve({
          ...message,
          body: body.trim(),
        }),
    );
    const comments = createComments(message, editUserMessage);
    const comment = requireComment(
      reconcileReviewComments("thread-1", [], [message])[0],
    );

    comments.editComment(comment);
    expect(comment.mode).toBe(vscode.CommentMode.Editing);
    expect(comment.hasDraft).toBe(true);
    comment.body = "Discarded draft.";
    comments.cancelCommentEdit(comment);
    expect(comment.mode).toBe(vscode.CommentMode.Preview);
    expect(comment.hasDraft).toBe(false);
    expect(commentBody(comment.body)).toBe(message.body);

    comments.editComment(comment);
    comment.body = "  Updated feedback.  ";
    await comments.saveComment(comment);

    expect(editUserMessage).toHaveBeenCalledWith(
      "thread-1",
      message.id,
      "  Updated feedback.  ",
      message.body,
    );
    expect(comment.mode).toBe(vscode.CommentMode.Preview);
    expect(comment.hasDraft).toBe(false);
    expect(commentBody(comment.body)).toBe("Updated feedback.");
    comments.dispose();
  });

  it("preserves an active draft when persisted comments synchronize", () => {
    const message = createMessage();
    const comments = createComments(message);
    const comment = requireComment(
      reconcileReviewComments("thread-1", [], [message])[0],
    );
    comments.editComment(comment);
    comment.body = "Unsaved draft.";

    const synchronized = reconcileReviewComments(
      "thread-1",
      [comment],
      [{ ...message, body: "Changed elsewhere." }],
    )[0];

    expect(synchronized).toBe(comment);
    expect(synchronized?.mode).toBe(vscode.CommentMode.Editing);
    expect(synchronized?.hasDraft).toBe(true);
    expect(synchronized?.savedBody).toBe("Changed elsewhere.");
    expect(synchronized?.editBaseBody).toBe(message.body);
    expect(commentBody(synchronized?.body)).toBe("Unsaved draft.");
    comments.dispose();
  });

  it("keeps a rejected draft available for another edit attempt", async () => {
    const message = createMessage();
    const comments = createComments(message, () =>
      Promise.reject(new Error("Review messages cannot be empty.")),
    );
    const comment = requireComment(
      reconcileReviewComments("thread-1", [], [message])[0],
    );
    comments.editComment(comment);
    comment.body = "   ";

    await expect(comments.saveComment(comment)).rejects.toThrow(
      "Review messages cannot be empty.",
    );
    expect(comment.mode).toBe(vscode.CommentMode.Preview);
    expect(comment.hasDraft).toBe(true);
    expect(commentBody(comment.body)).toBe("   ");

    comments.editComment(comment);
    expect(comment.mode).toBe(vscode.CommentMode.Editing);
    expect(comment.editBaseBody).toBe(message.body);
    comments.cancelCommentEdit(comment);
    expect(commentBody(comment.body)).toBe(message.body);
    expect(comment.hasDraft).toBe(false);
    comments.dispose();
  });

  it("expands a zero-width gutter range to the intended line", () => {
    const lineRange = new vscode.Range(4, 0, 4, 18);
    const lineAt = vi.fn(() => ({ range: lineRange }));
    const gutterRange = new vscode.Range(4, 0, 4, 0);

    expect(normalizeCommentRange({ lineAt }, gutterRange)).toBe(lineRange);
    expect(lineAt).toHaveBeenCalledWith(4);
  });

  it("uses canonical repository paths for modified document URIs", () => {
    const snapshot: ReviewSnapshot = {
      repository: createRepositoryIdentity("/canonical/repository"),
      branch: "refs/heads/main",
      source: {
        kind: "working-tree",
        baseCommit: "abc123",
      },
      files: [
        {
          path: "src/index.ts",
          status: "modified",
          baseUri: vscode.Uri.from({
            scheme: "git",
            path: "/src/index.ts",
          }),
          modifiedUri: vscode.Uri.file(
            "/workspace-link/repository/src/index.ts",
          ),
          diff: {
            header: "header",
            hunks: [],
            binary: false,
          },
          canComment: true,
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const canonical = canonicalizeReviewSnapshot(snapshot);

    expect(canonical.files[0]?.modifiedUri.fsPath).toBe(
      path.resolve("/canonical/repository/src/index.ts"),
    );
    expect(canonical.files[0]?.baseUri).toBe(snapshot.files[0]?.baseUri);
  });

  it("creates feedback from the active editor selection", async () => {
    const harness = createCommentsHarness([]);
    const snapshot = createSnapshot();
    const file = requireComment(snapshot.files[0]);
    harness.comments.setSnapshot(snapshot);
    const document = createDocument(file.modifiedUri);
    setActiveTextEditor({
      document,
      selection: new vscode.Selection(1, 0, 1, 3),
    });
    setWindowFunction("showInputBox", () => Promise.resolve("New feedback."));

    await harness.comments.addFromActiveEditor();

    expect(harness.repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "src/index.ts",
        languageId: "typescript",
        body: "New feedback.",
      }),
    );
    expect(harness.anchors.capture).toHaveBeenCalled();
    harness.comments.dispose();
  });

  it("rejects editors outside a commentable diff", async () => {
    const harness = createCommentsHarness([]);
    await expect(harness.comments.addFromActiveEditor()).rejects.toThrow(
      "Open a modified file before adding a review thread.",
    );

    const snapshot = createSnapshot(false);
    const file = requireComment(snapshot.files[0]);
    harness.comments.setSnapshot(snapshot);
    setActiveTextEditor({
      document: createDocument(file.modifiedUri),
      selection: new vscode.Selection(0, 0, 0, 1),
    });
    await expect(harness.comments.addFromActiveEditor()).rejects.toThrow(
      "not a commentable modified side",
    );
    harness.comments.dispose();
  });

  it("appends existing replies and persists new comment threads", async () => {
    const existing = createThread(createMessage());
    const harness = createCommentsHarness([existing]);
    const snapshot = createSnapshot();
    const file = requireComment(snapshot.files[0]);
    harness.comments.setSnapshot(snapshot);
    const persistedThread = requireComment(mockState.commentThreads[0]);

    await harness.comments.handleReply({
      thread: persistedThread,
      text: " Follow-up reply. ",
    });
    expect(harness.repository.appendUserReply).toHaveBeenCalledWith(
      existing.id,
      "Follow-up reply.",
    );

    const draftController = vscode.comments.createCommentController(
      "draft",
      "Draft",
    );
    const draft = draftController.createCommentThread(
      file.modifiedUri,
      new vscode.Range(1, 0, 1, 10),
      [],
    );
    setWorkspaceFunction("openTextDocument", () =>
      Promise.resolve(createDocument(file.modifiedUri)),
    );
    await harness.comments.handleReply({
      thread: draft,
      text: "Create a new thread.",
    });
    expect(harness.repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Create a new thread." }),
    );
    harness.comments.dispose();
  });

  it("resolves, reopens, reveals, and provides commenting ranges", async () => {
    const thread = createThread(createMessage());
    const harness = createCommentsHarness([thread]);
    const snapshot = createSnapshot();
    const file = requireComment(snapshot.files[0]);
    harness.comments.setSnapshot(snapshot);
    setWorkspaceFunction("openTextDocument", () =>
      Promise.resolve(createDocument(file.modifiedUri)),
    );
    const show = vi.fn(() => Promise.resolve(undefined));
    setWindowFunction("showTextDocument", show);

    await harness.comments.resolve(thread.id);
    await harness.comments.reopen(thread.id);
    await harness.comments.reveal(thread.id);

    expect(harness.repository.resolve).toHaveBeenCalledWith(thread.id);
    expect(harness.repository.reopen).toHaveBeenCalledWith(thread.id);
    expect(show).toHaveBeenCalled();

    const controller = requireComment(mockState.commentControllers[0]);
    const ranges =
      await controller.commentingRangeProvider?.provideCommentingRanges(
        createDocument(file.modifiedUri),
      );
    expect(Array.isArray(ranges) ? ranges : []).toHaveLength(1);
    harness.comments.dispose();
  });
});

function createComments(
  message: ReviewMessage,
  editUserMessage: ReviewCommentsRepository["editUserMessage"] = (
    _threadId,
    _messageId,
    body,
  ) => Promise.resolve({ ...message, body }),
): ReviewComments {
  const thread = createThread(message);
  const repository: ReviewCommentsRepository = {
    repository: createRepositoryIdentity("/workspace/repository"),
    list: () => [thread],
    get: (threadId) => (threadId === thread.id ? thread : undefined),
    onDidChange: () => ({ dispose: () => undefined }),
    create: (input: NewThreadInput) =>
      Promise.resolve({
        ...thread,
        filePath: input.filePath,
        messages: [{ ...message, body: input.body }],
      }),
    appendUserReply: () => Promise.resolve(message),
    editUserMessage,
    resolve: () => Promise.resolve(),
    reopen: () => Promise.resolve(),
  };
  return new ReviewComments(
    repository,
    {
      capture: () => thread.originalAnchor,
    },
    {
      createHistoricalDocument: () => ({
        uri: vscode.Uri.from({
          scheme: "revloop-history",
          path: thread.filePath,
        }),
        range: new vscode.Range(0, 0, 0, 1),
      }),
    },
  );
}

function createCommentsHarness(threads: readonly ReviewThread[]) {
  const identity = createRepositoryIdentity("/workspace/repository");
  const fallbackMessage = createMessage();
  const fallbackThread = createThread(fallbackMessage);
  const repository = {
    repository: identity,
    list: vi.fn(() => threads),
    get: vi.fn((threadId: string) =>
      threads.find((thread) => thread.id === threadId),
    ),
    onDidChange: vi.fn(() => ({ dispose: () => undefined })),
    create: vi.fn(() => Promise.resolve(fallbackThread)),
    appendUserReply: vi.fn(() => Promise.resolve(fallbackMessage)),
    editUserMessage: vi.fn(() => Promise.resolve(fallbackMessage)),
    resolve: vi.fn(() => Promise.resolve()),
    reopen: vi.fn(() => Promise.resolve()),
  } satisfies ReviewCommentsRepository;
  const anchors = {
    capture: vi.fn(() => fallbackThread.originalAnchor),
  };
  const documents = {
    createHistoricalDocument: vi.fn((thread: ReviewThread) => ({
      uri: vscode.Uri.from({
        scheme: "revloop-history",
        path: thread.filePath,
      }),
      range: new vscode.Range(0, 0, 0, 1),
    })),
  };
  return {
    comments: new ReviewComments(repository, anchors, documents),
    repository,
    anchors,
    documents,
  };
}

function createMessage(): ReviewMessage {
  return {
    id: "message-1",
    author: "user",
    body: "Original feedback.",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function createThread(message: ReviewMessage): ReviewThread {
  const anchor: AnchorSnapshot = {
    filePath: "src/index.ts",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    selectedText: "x",
    beforeContext: [],
    afterContext: [],
    contentHash: "hash",
    capturedAt: message.createdAt,
  };
  return {
    id: "thread-1",
    repositoryKey: "repository",
    branch: "refs/heads/main",
    filePath: anchor.filePath,
    languageId: "typescript",
    status: "open",
    originalAnchor: anchor,
    currentAnchor: anchor,
    anchorHistory: [{ kind: "created", at: message.createdAt }],
    diffContext: {
      header: "header",
      hunk: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    },
    messages: [message],
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  };
}

function createSnapshot(canComment = true): ReviewSnapshot {
  return {
    repository: createRepositoryIdentity("/workspace/repository"),
    branch: "refs/heads/main",
    source: {
      kind: "working-tree",
      baseCommit: "abc123",
    },
    files: [
      {
        path: "src/index.ts",
        status: "modified",
        baseUri: vscode.Uri.from({
          scheme: "git",
          path: "/src/index.ts",
        }),
        modifiedUri: vscode.Uri.file("/workspace/repository/src/index.ts"),
        diff: {
          header: "header",
          hunks: [
            {
              header: "@@ -1,2 +1,2 @@",
              hunk: "@@ -1,2 +1,2 @@\n-old\n+new",
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              modifiedLines: [1],
            },
          ],
          binary: false,
        },
        canComment,
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function createDocument(uri: vscode.Uri) {
  const lines = ["before", "new", "after"];
  return {
    uri,
    languageId: "typescript",
    lineCount: lines.length,
    getText: () => lines.join("\n"),
    lineAt: (line: number) => ({
      text: lines[line] ?? "",
      range: new vscode.Range(line, 0, line, (lines[line] ?? "").length),
    }),
  };
}

function createRepositoryIdentity(rootPath: string): RepositoryIdentity {
  return {
    key: "repository",
    rootPath,
    displayName: "repository",
    storageRoot: `${rootPath}/.git/revloop`,
  };
}

function requireComment<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a review comment.");
  }
  return value;
}

function commentBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "value" in body &&
    typeof body.value === "string"
  ) {
    return body.value;
  }
  throw new Error("Unexpected comment body.");
}

function setActiveTextEditor(editor: unknown): void {
  Object.defineProperty(vscode.window, "activeTextEditor", {
    configurable: true,
    value: editor,
  });
}

function setWindowFunction(
  name: "showInputBox" | "showTextDocument",
  value: (...arguments_: unknown[]) => unknown,
): void {
  Object.defineProperty(vscode.window, name, {
    configurable: true,
    value,
  });
}

function setWorkspaceFunction(
  name: "openTextDocument",
  value: (...arguments_: unknown[]) => unknown,
): void {
  Object.defineProperty(vscode.workspace, name, {
    configurable: true,
    value,
  });
}
