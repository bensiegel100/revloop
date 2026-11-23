import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activate, isNonGitWindowError } from "../../src/extension.js";

const reviewController = vi.hoisted(() => ({
  addThread: vi.fn(),
  cancelCommentEdit: vi.fn(),
  editComment: vi.fn(),
  initialize: vi.fn(),
  openFile: vi.fn(),
  refresh: vi.fn(),
  reopen: vi.fn(),
  reply: vi.fn(),
  resolve: vi.fn(),
  saveComment: vi.fn(),
  startBranchReview: vi.fn(),
  startWorkingTreeReview: vi.fn(),
}));
const documentProvider = vi.hoisted(() => ({
  register: vi.fn(),
}));

vi.mock("../../src/git/gitService.js", () => ({
  GitService: class {
    public readonly kind = "git";
  },
}));
vi.mock("../../src/git/reviewDocumentProvider.js", () => ({
  ReviewDocumentProvider: class {
    public register = documentProvider.register;
  },
}));
vi.mock("../../src/storage/threadRepository.js", () => ({
  ThreadRepository: class {
    public dispose = vi.fn();
  },
}));
vi.mock("../../src/reviewController.js", () => ({
  ReviewController: class {
    public addThread = reviewController.addThread;
    public cancelCommentEdit = reviewController.cancelCommentEdit;
    public editComment = reviewController.editComment;
    public initialize = reviewController.initialize;
    public openFile = reviewController.openFile;
    public refresh = reviewController.refresh;
    public reopen = reviewController.reopen;
    public reply = reviewController.reply;
    public resolve = reviewController.resolve;
    public saveComment = reviewController.saveComment;
    public startBranchReview = reviewController.startBranchReview;
    public startWorkingTreeReview = reviewController.startWorkingTreeReview;
    public dispose = vi.fn();
  },
}));

beforeEach(() => {
  for (const mock of Object.values(reviewController)) {
    mock.mockReset();
    mock.mockResolvedValue(undefined);
  }
  documentProvider.register.mockReset();
});

describe("extension activation", () => {
  it("registers and dispatches every command", async () => {
    const context = createContext();
    await activate(context);

    expect(documentProvider.register).toHaveBeenCalledWith(context);
    expect(reviewController.initialize).toHaveBeenCalledOnce();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "revloop.startWorkingTreeReview",
      "revloop.startBranchReview",
      "revloop.addThread",
      "revloop.replyToThread",
      "revloop.editComment",
      "revloop.saveComment",
      "revloop.cancelCommentEdit",
      "revloop.resolveThread",
      "revloop.reopenThread",
      "revloop.openFile",
      "revloop.refresh",
    ]) {
      expect(commands).toContain(command);
    }

    const reply = {
      thread: {},
      text: "Reply",
    };
    await vscode.commands.executeCommand("revloop.startWorkingTreeReview");
    await vscode.commands.executeCommand("revloop.startBranchReview");
    await vscode.commands.executeCommand("revloop.addThread");
    await vscode.commands.executeCommand("revloop.replyToThread", reply);
    await vscode.commands.executeCommand("revloop.editComment", "comment");
    await vscode.commands.executeCommand("revloop.saveComment", "comment");
    await vscode.commands.executeCommand(
      "revloop.cancelCommentEdit",
      "comment",
    );
    await vscode.commands.executeCommand("revloop.resolveThread", "thread");
    await vscode.commands.executeCommand("revloop.reopenThread", "thread");
    await vscode.commands.executeCommand("revloop.openFile", "src/index.ts");
    await vscode.commands.executeCommand("revloop.refresh");

    expect(reviewController.reply).toHaveBeenCalledWith(reply);
    expect(reviewController.refresh).toHaveBeenCalledOnce();
  });

  it("handles expected and unexpected initialization errors", async () => {
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    reviewController.initialize.mockRejectedValueOnce(
      new Error("Open a workspace containing a Git repository first."),
    );
    await activate(createContext());
    expect(warning).not.toHaveBeenCalled();

    reviewController.initialize.mockRejectedValueOnce(
      new Error("The Git extension failed."),
    );
    await activate(createContext());
    expect(warning).toHaveBeenCalledWith("The Git extension failed.");
  });

  it("suppresses only the expected non-Git window failure", () => {
    expect(
      isNonGitWindowError(
        new Error("Open a workspace containing a Git repository first."),
      ),
    ).toBe(true);
    expect(
      isNonGitWindowError(
        new Error("The built-in VS Code Git extension is disabled."),
      ),
    ).toBe(false);
    expect(isNonGitWindowError("not an error")).toBe(false);
  });
});

function createContext(): Pick<
  vscode.ExtensionContext,
  "globalStorageUri" | "subscriptions"
> {
  return {
    subscriptions: [],
    globalStorageUri: vscode.Uri.file("/tmp/revloop"),
  };
}
