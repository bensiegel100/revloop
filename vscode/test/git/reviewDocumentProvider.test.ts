import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { ReviewThread } from "@revloop/shared";
import { ReviewDocumentProvider } from "../../src/git/reviewDocumentProvider.js";

describe("review document provider", () => {
  it("stores empty, snapshot, and historical documents", () => {
    const provider = new ReviewDocumentProvider();
    const changes: string[] = [];
    provider.onDidChange((uri) => {
      changes.push(uri.toString());
    });

    const empty = provider.createEmptyUri("repository", "src/index.ts");
    const snapshot = provider.createSnapshotUri(
      "repository",
      "src/index.ts",
      "first",
    );
    provider.createSnapshotUri("repository", "src/index.ts", "first");
    provider.createSnapshotUri("repository", "src/index.ts", "second");
    const historical = provider.createHistoricalDocument(createThread());

    expect(empty.scheme).toBe("revloop-empty");
    expect(provider.provideTextDocumentContent(snapshot)).toBe("second");
    expect(provider.provideTextDocumentContent(historical.uri)).toContain(
      "const value = 1;",
    );
    expect(
      provider.provideTextDocumentContent(
        vscode.Uri.from({ scheme: "unknown", path: "/missing" }),
      ),
    ).toBe("");
    expect(changes).toHaveLength(3);
  });

  it("registers every virtual document scheme", () => {
    const provider = new ReviewDocumentProvider();
    const subscriptions: vscode.Disposable[] = [];
    const register = vi.spyOn(
      vscode.workspace,
      "registerTextDocumentContentProvider",
    );

    provider.register({ subscriptions });

    expect(register).toHaveBeenCalledTimes(3);
    expect(subscriptions).toHaveLength(4);
  });
});

function createThread(): ReviewThread {
  const now = "2026-01-01T00:00:00.000Z";
  const anchor = {
    filePath: "src/index.ts",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    selectedText: "const",
    beforeContext: [],
    afterContext: [],
    contentHash: "hash",
    capturedAt: now,
  };
  return {
    id: "thread-1",
    repositoryKey: "repository",
    branch: "refs/heads/main",
    filePath: anchor.filePath,
    languageId: "typescript",
    status: "outdated",
    originalAnchor: anchor,
    currentAnchor: null,
    anchorHistory: [{ kind: "created", at: now }],
    diffContext: {
      header: "header",
      hunk: "@@ -0,0 +1 @@\n+const value = 1;",
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
    },
    messages: [
      {
        id: "message-1",
        author: "user",
        body: "Review this.",
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
