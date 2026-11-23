import * as vscode from "vscode";
import { JsonReviewStore } from "@revloop/shared";
import { GitService } from "./git/gitService.js";
import { ReviewDocumentProvider } from "./git/reviewDocumentProvider.js";
import { ReviewController } from "./reviewController.js";
import { ThreadRepository } from "./storage/threadRepository.js";

export async function activate(
  context: Pick<vscode.ExtensionContext, "globalStorageUri" | "subscriptions">,
): Promise<void> {
  const documentProvider = new ReviewDocumentProvider();
  documentProvider.register(context);

  const store = new JsonReviewStore(context.globalStorageUri.fsPath);
  const threads = new ThreadRepository(store);
  const git = new GitService(documentProvider);
  const reviews = new ReviewController(context, git, threads, documentProvider);
  context.subscriptions.push(reviews, threads);

  registerCommand(context, "revloop.startWorkingTreeReview", () =>
    reviews.startWorkingTreeReview(),
  );
  registerCommand(context, "revloop.startBranchReview", () =>
    reviews.startBranchReview(),
  );
  registerCommand(context, "revloop.addThread", () => reviews.addThread());
  registerCommand(context, "revloop.replyToThread", async (argument) => {
    if (!isCommentReply(argument)) {
      throw new Error("No comment reply was supplied.");
    }
    await reviews.reply(argument);
  });
  registerCommand(context, "revloop.editComment", (argument) =>
    reviews.editComment(argument),
  );
  registerCommand(context, "revloop.saveComment", (argument) =>
    reviews.saveComment(argument),
  );
  registerCommand(context, "revloop.cancelCommentEdit", (argument) =>
    reviews.cancelCommentEdit(argument),
  );
  registerCommand(context, "revloop.resolveThread", (argument) =>
    reviews.resolve(argument),
  );
  registerCommand(context, "revloop.reopenThread", (argument) =>
    reviews.reopen(argument),
  );
  registerCommand(context, "revloop.openFile", (argument) =>
    reviews.openFile(argument),
  );
  registerCommand(context, "revloop.refresh", () => reviews.refresh());

  try {
    await reviews.initialize();
  } catch (error: unknown) {
    await vscode.commands.executeCommand(
      "setContext",
      "revloop.reviewActive",
      false,
    );
    if (isNonGitWindowError(error)) {
      return;
    }
    void vscode.window.showWarningMessage(toErrorMessage(error));
    return;
  }
}

function registerCommand(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  command: string,
  handler: (argument?: unknown) => Promise<void>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(command, (argument?: unknown) =>
      handler(argument).catch((error: unknown) => {
        void vscode.window.showErrorMessage(toErrorMessage(error));
      }),
    ),
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCommentReply(value: unknown): value is vscode.CommentReply {
  return (
    typeof value === "object" &&
    value !== null &&
    "thread" in value &&
    "text" in value &&
    typeof value.text === "string"
  );
}

export function isNonGitWindowError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Open a workspace containing a Git repository first."
  );
}
