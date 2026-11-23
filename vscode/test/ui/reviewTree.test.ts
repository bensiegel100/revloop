import * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import type { ReviewThread } from "@revloop/shared";
import type { ReviewSnapshot } from "../../src/git/types.js";
import {
  ReviewDirectoryItem,
  ReviewFileItem,
  ReviewThreadItem,
  ReviewTreeProvider,
} from "../../src/ui/reviewTree.js";
import type { ReviewTreeRepository } from "../../src/ui/reviewTree.js";

describe("review tree", () => {
  it("uses status-specific file icons", () => {
    expect(
      new ReviewFileItem(
        "src/added.ts",
        [],
        createFile("src/added.ts", "added"),
      ).iconPath,
    ).toMatchObject({ id: "diff-added" });
    expect(
      new ReviewFileItem(
        "src/deleted.ts",
        [],
        createFile("src/deleted.ts", "deleted"),
      ).iconPath,
    ).toMatchObject({ id: "diff-removed" });
    expect(
      new ReviewFileItem(
        "src/renamed.ts",
        [],
        createFile("src/renamed.ts", "renamed"),
      ).iconPath,
    ).toMatchObject({ id: "diff-renamed" });
  });

  it("nests clickable threads beneath clickable files", () => {
    let repositoryThreads = [
      createThread(
        "thread-1",
        "src/ui/comments.ts",
        "2026-01-01T00:00:00Z",
        "Clarify this comment behavior.",
      ),
      createThread(
        "thread-2",
        "archive/old.ts",
        "2026-01-01T00:01:00Z",
        "Keep the historical behavior.",
        20,
        null,
      ),
      createThread(
        "thread-3",
        "archive/old.ts",
        "2026-01-01T00:02:00Z",
        "Add coverage for this path.",
        30,
        5,
      ),
    ];
    let changeListener:
      ((threads: readonly ReviewThread[]) => void) | undefined;
    let subscriptionDisposed = false;
    const repository: ReviewTreeRepository = {
      list: () => repositoryThreads,
      onDidChange: (listener) => {
        changeListener = listener;
        return {
          dispose: () => {
            subscriptionDisposed = true;
          },
        };
      },
    };
    const provider = new ReviewTreeProvider(repository);
    const snapshot: ReviewSnapshot = {
      repository: {
        key: "repository",
        rootPath: "/workspace/repository",
        displayName: "repository",
        storageRoot: "/workspace/repository/.git/revloop",
      },
      branch: "refs/heads/main",
      source: {
        kind: "working-tree",
        baseCommit: "abc123",
      },
      files: [
        createFile("README.md"),
        createFile("src/git/types.ts"),
        createFile("src/ui/comments.ts"),
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    provider.setSnapshot(snapshot);

    const root = provider.getChildren();
    expect(root.map((item) => item.label)).toEqual([
      "archive",
      "src",
      "README.md",
    ]);
    expect(root[0]).toBeInstanceOf(ReviewDirectoryItem);
    expect(root[0]?.command).toBeUndefined();

    const archiveChildren = provider.getChildren(root[0]);
    expect(archiveChildren).toHaveLength(1);
    expect(archiveChildren[0]?.label).toBe("old.ts");
    expect(
      archiveChildren[0] instanceof ReviewFileItem
        ? archiveChildren[0].threads
        : [],
    ).toHaveLength(2);
    expect(archiveChildren[0]?.collapsibleState).toBe(
      vscode.TreeItemCollapsibleState.Expanded,
    );
    expect(archiveChildren[0]?.command?.command).toBe("revloop.openFile");
    const archiveThreads = provider.getChildren(archiveChildren[0]);
    expect(archiveThreads.map((item) => item.label)).toEqual([
      "Add coverage for this path.",
      "Keep the historical behavior.",
    ]);
    expect(
      archiveThreads.every((item) => item instanceof ReviewThreadItem),
    ).toBe(true);
    expect(archiveThreads.map((item) => item.command?.command)).toEqual([
      "revloop.openThread",
      "revloop.openThread",
    ]);

    const sourceChildren = provider.getChildren(root[1]);
    expect(sourceChildren.map((item) => item.label)).toEqual(["git", "ui"]);

    const uiChildren = provider.getChildren(sourceChildren[1]);
    expect(uiChildren).toHaveLength(1);
    const commentsFile = uiChildren[0];
    expect(commentsFile).toBeInstanceOf(ReviewFileItem);
    expect(commentsFile?.label).toBe("comments.ts");
    expect(commentsFile?.tooltip).toBe("src/ui/comments.ts");
    expect(commentsFile?.description).toBe("1");
    expect(commentsFile?.collapsibleState).toBe(
      vscode.TreeItemCollapsibleState.Expanded,
    );
    expect(commentsFile?.command?.command).toBe("revloop.openFile");
    const commentThreads = provider.getChildren(commentsFile);
    expect(commentThreads).toHaveLength(1);
    expect(commentThreads[0]).toBeInstanceOf(ReviewThreadItem);
    expect(commentThreads[0]?.label).toBe("Clarify this comment behavior.");
    expect(commentThreads[0]?.command?.command).toBe("revloop.openThread");
    expect(provider.getChildren(commentThreads[0])).toEqual([]);

    repositoryThreads = [];
    provider.refresh();
    changeListener?.([]);
    expect(provider.getChildren()).toHaveLength(2);
    provider.dispose();
    expect(subscriptionDisposed).toBe(true);
  });

  it("uses the first human comment as a truncated thread label", () => {
    const body = "A".repeat(90);
    const thread = createThread(
      "thread-1",
      "src/index.ts",
      "2026-01-01T00:00:00Z",
      body,
    );
    thread.messages.unshift({
      id: "agent-message",
      author: "agent",
      body: "Agent response.",
      createdAt: "2025-12-31T23:59:00Z",
      outcome: "answered",
    });

    const item = new ReviewThreadItem(thread);

    expect(item.label).toBe(`${"A".repeat(77)}...`);
    expect(item.tooltip).toBe(body);
    expect(item.command?.arguments).toEqual([item]);
  });
});

function createFile(
  filePath: string,
  status: ReviewSnapshot["files"][number]["status"] = "modified",
): ReviewSnapshot["files"][number] {
  return {
    path: filePath,
    status,
    baseUri: vscode.Uri.from({ scheme: "git", path: filePath }),
    modifiedUri: vscode.Uri.file(`/workspace/repository/${filePath}`),
    diff: {
      header: "header",
      hunks: [],
      binary: false,
    },
    canComment: false,
  };
}

function createThread(
  id: string,
  filePath: string,
  createdAt: string,
  body = "Review this.",
  originalLine = 0,
  currentLine: number | null = originalLine,
): ReviewThread {
  const anchor = {
    filePath,
    range: {
      start: { line: originalLine, character: 0 },
      end: { line: originalLine, character: 1 },
    },
    selectedText: "x",
    beforeContext: [],
    afterContext: [],
    contentHash: "hash",
    capturedAt: createdAt,
  };
  return {
    id,
    repositoryKey: "repository",
    branch: "refs/heads/main",
    filePath,
    languageId: "typescript",
    status: "open",
    originalAnchor: anchor,
    currentAnchor:
      currentLine === null
        ? null
        : {
            ...anchor,
            range: {
              start: { line: currentLine, character: 0 },
              end: { line: currentLine, character: 1 },
            },
          },
    anchorHistory: [{ kind: "created", at: createdAt }],
    diffContext: {
      header: "header",
      hunk: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    },
    messages: [
      {
        id: `${id}-message`,
        author: "user",
        body,
        createdAt,
      },
    ],
    createdAt,
    updatedAt: createdAt,
  };
}
