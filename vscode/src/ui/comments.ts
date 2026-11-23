import { realpathSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { resolveRepositoryPath } from "@revloop/shared";
import type { ReviewMessage, ReviewThread } from "@revloop/shared";
import type { AnchorManager } from "../anchors/anchorManager.js";
import { toVscodeRange } from "../anchors/anchorManager.js";
import { findHunkForLines, toContiguousLineRanges } from "../git/diffParser.js";
import type { ReviewFile, ReviewSnapshot } from "../git/types.js";
import type { ReviewDocumentProvider } from "../git/reviewDocumentProvider.js";
import type { ThreadRepository } from "../storage/threadRepository.js";

export type ReviewCommentsRepository = Pick<
  ThreadRepository,
  | "appendUserReply"
  | "create"
  | "editUserMessage"
  | "get"
  | "list"
  | "onDidChange"
  | "reopen"
  | "repository"
  | "resolve"
>;

export class ReviewComment implements vscode.Comment {
  public mode = vscode.CommentMode.Preview;
  public body: string | vscode.MarkdownString;
  public readonly author: vscode.CommentAuthorInformation;
  public readonly timestamp: Date;
  public readonly contextValue: string;
  public readonly label?: string;
  public savedBody: string;
  public editBaseBody: string;
  public hasDraft = false;

  public constructor(
    public readonly threadId: string,
    public readonly messageId: string,
    message: ReviewMessage,
  ) {
    this.body = new vscode.MarkdownString(message.body);
    this.savedBody = message.body;
    this.editBaseBody = message.body;
    this.author = {
      name: message.author === "agent" ? "GitHub Copilot" : "You",
    };
    this.timestamp = new Date(message.createdAt);
    this.contextValue =
      message.author === "user" ? "revloop.user" : "revloop.agent";
    if (message.author === "agent" && message.outcome !== undefined) {
      this.label = message.outcome;
    }
  }

  public syncMessage(message: ReviewMessage): void {
    this.savedBody = message.body;
    if (!this.hasDraft) {
      this.body = new vscode.MarkdownString(message.body);
      this.editBaseBody = message.body;
      this.mode = vscode.CommentMode.Preview;
    }
  }
}

export class ReviewComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(
    "revloop",
    "Revloop",
  );
  private readonly threadsById = new Map<string, vscode.CommentThread>();
  private readonly idsByThread = new WeakMap<vscode.CommentThread, string>();
  private snapshot: ReviewSnapshot | undefined;
  private readonly repositorySubscription: { dispose(): void };

  public constructor(
    private readonly repository: ReviewCommentsRepository,
    private readonly anchors: Pick<AnchorManager, "capture">,
    private readonly documents: Pick<
      ReviewDocumentProvider,
      "createHistoricalDocument"
    >,
  ) {
    this.controller.options = {
      prompt: "Add review feedback",
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) =>
        this.provideCommentingRanges(document),
    };
    this.repositorySubscription = repository.onDidChange((threads) => {
      this.syncThreads(threads);
    });
  }

  public setSnapshot(snapshot: ReviewSnapshot | undefined): void {
    this.snapshot =
      snapshot === undefined ? undefined : canonicalizeReviewSnapshot(snapshot);
    this.syncThreads(this.repository.list());
  }

  public async addFromActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      throw new Error("Open a modified file before adding a review thread.");
    }

    const file = this.fileForUri(editor.document.uri);
    if (file?.canComment !== true) {
      throw new Error(
        "The active editor is not a commentable modified side of this review.",
      );
    }

    const range = normalizeEditorSelection(editor);
    assertRangeIsModified(file, range);
    const body = await vscode.window.showInputBox({
      prompt: "Add review feedback",
      placeHolder: "Describe the requested change or ask a question",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? "Feedback is required." : undefined,
    });
    if (body === undefined) {
      return;
    }

    await this.createPersistedThread(editor.document, file, range, body);
  }

  public async handleReply(reply: vscode.CommentReply): Promise<void> {
    const body = reply.text.trim();
    if (body.length === 0) {
      return;
    }

    const threadId = this.idsByThread.get(reply.thread);
    if (threadId !== undefined) {
      await this.repository.appendUserReply(threadId, body);
      return;
    }

    const range = reply.thread.range;
    if (range === undefined) {
      throw new Error("File-level review comments are not supported.");
    }

    const file = this.fileForUri(reply.thread.uri);
    if (file === undefined) {
      throw new Error("This comment is outside the active review.");
    }

    const document = await vscode.workspace.openTextDocument(reply.thread.uri);
    const created = await this.createPersistedThread(
      document,
      file,
      range,
      body,
    );
    reply.thread.dispose();
    const persistedThread = this.threadsById.get(created.id);
    if (persistedThread) {
      persistedThread.collapsibleState =
        vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  public editComment(argument: unknown): void {
    const comment = this.requireEditableComment(argument);
    comment.editBaseBody = comment.savedBody;
    comment.hasDraft = true;
    comment.mode = vscode.CommentMode.Editing;
    this.refreshCommentThread(comment.threadId);
  }

  public async saveComment(argument: unknown): Promise<void> {
    const comment = this.requireEditableComment(argument);
    try {
      const message = await this.repository.editUserMessage(
        comment.threadId,
        comment.messageId,
        commentBody(comment.body),
        comment.editBaseBody,
      );
      comment.body = new vscode.MarkdownString(message.body);
      comment.savedBody = message.body;
      comment.editBaseBody = message.body;
      comment.hasDraft = false;
      comment.mode = vscode.CommentMode.Preview;
      this.refreshCommentThread(comment.threadId);
    } catch (error: unknown) {
      comment.mode = vscode.CommentMode.Preview;
      this.refreshCommentThread(comment.threadId);
      throw error;
    }
  }

  public cancelCommentEdit(argument: unknown): void {
    const comment = this.requireEditableComment(argument);
    comment.body = new vscode.MarkdownString(comment.savedBody);
    comment.editBaseBody = comment.savedBody;
    comment.hasDraft = false;
    comment.mode = vscode.CommentMode.Preview;
    this.refreshCommentThread(comment.threadId);
  }

  public async resolve(argument: unknown): Promise<void> {
    const threadId = this.resolveThreadId(argument);
    if (threadId === undefined) {
      throw new Error("No review thread was supplied.");
    }
    await this.repository.resolve(threadId);
  }

  public async reopen(argument: unknown): Promise<void> {
    const threadId = this.resolveThreadId(argument);
    if (threadId === undefined) {
      throw new Error("No review thread was supplied.");
    }
    await this.repository.reopen(threadId);
  }

  public expand(threadId: string): void {
    const commentThread = this.threadsById.get(threadId);
    if (commentThread === undefined) {
      throw new Error(`Unknown review thread: ${threadId}`);
    }
    commentThread.collapsibleState =
      vscode.CommentThreadCollapsibleState.Expanded;
  }

  public async reveal(threadId: string): Promise<void> {
    const thread = this.repository.get(threadId);
    if (thread === undefined) {
      throw new Error(`Unknown review thread: ${threadId}`);
    }

    const commentThread = this.threadsById.get(threadId);
    const anchor = thread.currentAnchor ?? thread.originalAnchor;
    const target =
      commentThread === undefined
        ? this.threadDocument(thread)
        : {
            uri: commentThread.uri,
            range: commentThread.range ?? toVscodeRange(anchor.range),
          };
    const document = await vscode.workspace.openTextDocument(target.uri);
    await vscode.window.showTextDocument(document, {
      preview: true,
      selection: target.range,
    });
    if (commentThread !== undefined) {
      this.expand(threadId);
    }
  }

  public dispose(): void {
    this.repositorySubscription.dispose();
    this.controller.dispose();
    this.threadsById.clear();
  }

  private provideCommentingRanges(
    document: vscode.TextDocument,
  ): vscode.Range[] {
    const file = this.fileForUri(document.uri);
    if (file?.canComment !== true) {
      return [];
    }

    const lines = file.diff.hunks.flatMap((hunk) => hunk.modifiedLines);
    return toContiguousLineRanges(lines).map(
      ([start, end]) =>
        new vscode.Range(
          start,
          0,
          end,
          document.lineAt(Math.min(end, document.lineCount - 1)).text.length,
        ),
    );
  }

  private async createPersistedThread(
    document: vscode.TextDocument,
    file: ReviewFile,
    range: vscode.Range,
    body: string,
  ): Promise<ReviewThread> {
    const normalizedRange = normalizeCommentRange(document, range);
    assertRangeIsModified(file, normalizedRange);
    const hunk = findHunkForLines(
      file.diff,
      normalizedRange.start.line,
      normalizedRange.end.line,
    );
    if (hunk === undefined) {
      throw new Error(
        "The selected lines are not part of a reviewed diff hunk.",
      );
    }

    return this.repository.create({
      filePath: file.path,
      languageId: document.languageId,
      anchor: this.anchors.capture(document, file.path, normalizedRange),
      diffContext: {
        header: hunk.header,
        hunk: hunk.hunk,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
      },
      body,
    });
  }

  private syncThreads(threads: readonly ReviewThread[]): void {
    const currentIds = new Set(threads.map((thread) => thread.id));
    for (const [threadId, commentThread] of this.threadsById) {
      if (!currentIds.has(threadId)) {
        commentThread.dispose();
        this.threadsById.delete(threadId);
      }
    }

    for (const thread of threads) {
      const target = this.threadDocument(thread);
      let commentThread = this.threadsById.get(thread.id);
      const comments = reconcileReviewComments(
        thread.id,
        commentThread?.comments ?? [],
        thread.messages,
      );
      if (commentThread?.uri.toString() !== target.uri.toString()) {
        commentThread?.dispose();
        commentThread = this.controller.createCommentThread(
          target.uri,
          target.range,
          comments,
        );
        this.threadsById.set(thread.id, commentThread);
        this.idsByThread.set(commentThread, thread.id);
      } else {
        commentThread.range = target.range;
        commentThread.comments = comments;
      }

      commentThread.canReply = true;
      commentThread.label = thread.status === "outdated" ? "Outdated" : "";
      commentThread.state =
        thread.status === "resolved"
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
      commentThread.contextValue =
        thread.status === "resolved"
          ? "revloop.resolved"
          : thread.status === "outdated"
            ? "revloop.outdated"
            : "revloop.open";
    }
  }

  private threadDocument(thread: ReviewThread): {
    uri: vscode.Uri;
    range: vscode.Range;
  } {
    if (thread.currentAnchor === null) {
      return this.documents.createHistoricalDocument(thread);
    }

    return {
      uri: vscode.Uri.file(
        resolveRepositoryPath(
          this.repository.repository.rootPath,
          thread.filePath,
        ),
      ),
      range: toVscodeRange(thread.currentAnchor.range),
    };
  }

  private fileForUri(uri: vscode.Uri): ReviewFile | undefined {
    const canonicalUri = canonicalFileUri(uri);
    return this.snapshot?.files.find((file) => {
      const modifiedUri = canonicalFileUri(file.modifiedUri);
      return modifiedUri.toString() === canonicalUri.toString();
    });
  }

  private resolveThreadId(argument: unknown): string | undefined {
    if (isCommentReply(argument)) {
      return this.idsByThread.get(argument.thread);
    }
    if (isCommentThread(argument)) {
      return this.idsByThread.get(argument);
    }
    if (isThreadItem(argument)) {
      return argument.thread.id;
    }
    if (typeof argument === "string") {
      return argument;
    }
    return undefined;
  }

  private requireEditableComment(argument: unknown): ReviewComment {
    if (!isReviewComment(argument)) {
      throw new Error("No review comment was supplied.");
    }

    const message = this.repository
      .get(argument.threadId)
      ?.messages.find((candidate) => candidate.id === argument.messageId);
    if (message === undefined) {
      throw new Error(`Unknown review message: ${argument.messageId}`);
    }
    if (message.author !== "user") {
      throw new Error("Only user-authored review messages can be edited.");
    }

    return argument;
  }

  private refreshCommentThread(threadId: string): void {
    const thread = this.threadsById.get(threadId);
    if (thread !== undefined) {
      thread.comments = [...thread.comments];
    }
  }
}

function normalizeEditorSelection(editor: vscode.TextEditor): vscode.Range {
  if (!editor.selection.isEmpty) {
    return new vscode.Range(editor.selection.start, editor.selection.end);
  }

  const line = editor.selection.active.line;
  return editor.document.lineAt(line).range;
}

export function normalizeCommentRange(
  document: {
    lineAt(line: number): Pick<vscode.TextLine, "range">;
  },
  range: vscode.Range,
): vscode.Range {
  return range.isEmpty ? document.lineAt(range.start.line).range : range;
}

export function canonicalizeReviewSnapshot(
  snapshot: ReviewSnapshot,
): ReviewSnapshot {
  return {
    ...snapshot,
    files: snapshot.files.map((file) =>
      file.modifiedUri.scheme === "file"
        ? {
            ...file,
            modifiedUri: vscode.Uri.file(
              resolveRepositoryPath(snapshot.repository.rootPath, file.path),
            ),
          }
        : file,
    ),
  };
}

function assertRangeIsModified(file: ReviewFile, range: vscode.Range): void {
  const modifiedLines = new Set(
    file.diff.hunks.flatMap((hunk) => hunk.modifiedLines),
  );
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    if (modifiedLines.has(line)) {
      return;
    }
  }

  throw new Error("Select at least one added or modified line.");
}

function isCommentReply(value: unknown): value is vscode.CommentReply {
  return (
    typeof value === "object" &&
    value !== null &&
    "thread" in value &&
    "text" in value
  );
}

function isCommentThread(value: unknown): value is vscode.CommentThread {
  return (
    typeof value === "object" &&
    value !== null &&
    "comments" in value &&
    "dispose" in value &&
    "uri" in value
  );
}

function isThreadItem(value: unknown): value is { thread: ReviewThread } {
  return typeof value === "object" && value !== null && "thread" in value;
}

function isReviewComment(value: unknown): value is ReviewComment {
  return (
    typeof value === "object" &&
    value !== null &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    "messageId" in value &&
    typeof value.messageId === "string" &&
    "body" in value &&
    "mode" in value &&
    "savedBody" in value &&
    typeof value.savedBody === "string" &&
    "editBaseBody" in value &&
    typeof value.editBaseBody === "string" &&
    "hasDraft" in value &&
    typeof value.hasDraft === "boolean"
  );
}

export function reconcileReviewComments(
  threadId: string,
  existingComments: readonly vscode.Comment[],
  messages: readonly ReviewMessage[],
): ReviewComment[] {
  const existingById = new Map<string, ReviewComment>();
  for (const comment of existingComments) {
    if (isReviewComment(comment) && comment.threadId === threadId) {
      existingById.set(comment.messageId, comment);
    }
  }

  return messages.map((message) => {
    const existing = existingById.get(message.id);
    if (existing === undefined) {
      return new ReviewComment(threadId, message.id, message);
    }

    existing.syncMessage(message);
    return existing;
  });
}

function commentBody(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}

function canonicalFileUri(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme !== "file") {
    return uri;
  }

  try {
    return vscode.Uri.file(realpathSync.native(uri.fsPath));
  } catch {
    return vscode.Uri.file(path.resolve(uri.fsPath));
  }
}
