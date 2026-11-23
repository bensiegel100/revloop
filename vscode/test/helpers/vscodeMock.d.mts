import type * as vscode from "vscode";

export const mockState: {
  commentControllers: Array<{
    commentingRangeProvider?: {
      provideCommentingRanges(
        document: unknown,
        token?: unknown,
      ):
        | readonly vscode.Range[]
        | vscode.CommentingRanges
        | undefined
        | null
        | PromiseLike<
            readonly vscode.Range[] | vscode.CommentingRanges | undefined | null
          >;
    };
    options?: vscode.CommentOptions;
    createCommentThread(
      uri: vscode.Uri,
      range: vscode.Range | undefined,
      comments: readonly vscode.Comment[],
    ): vscode.CommentThread;
    dispose(): void;
  }>;
  commentThreads: vscode.CommentThread[];
  executedCommands: Array<{
    command: string;
    arguments: unknown[];
  }>;
  registeredCommands: Map<string, (...arguments_: unknown[]) => unknown>;
  treeViews: unknown[];
};

export function resetVscodeMock(): void;
