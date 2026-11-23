import { describe, expect, it } from "vitest";
import type { ReviewThread } from "@revloop/shared";
import { buildHistoricalDocument } from "../../src/domain/historicalDocument.js";

describe("historical review documents", () => {
  it("reconstructs the modified side of the original diff hunk", () => {
    const historical = buildHistoricalDocument(createThread());

    expect(historical.content).toBe(
      [
        'import { createHash } from "node:crypto";',
        "",
        "export function sha256(value: string): string {",
        '  return createHash("sha256").update(value).digest("hex");',
        "}",
      ].join("\n"),
    );
    expect(historical.range).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 2, character: 0 },
    });
  });

  it("keeps source lines beginning with two plus signs", () => {
    const thread = createThread();
    thread.diffContext = {
      ...thread.diffContext,
      hunk: ["@@ -0,0 +1,2 @@", "+++counter;", "+after"].join("\n"),
      newLines: 2,
    };

    expect(buildHistoricalDocument(thread).content).toBe("++counter;\nafter");
  });

  it("falls back to captured anchor context when the hunk has no lines", () => {
    const thread = createThread();
    thread.diffContext = {
      ...thread.diffContext,
      hunk: "@@ -10,0 +10,0 @@",
      newStart: 10,
      newLines: 0,
    };
    thread.originalAnchor = {
      ...thread.originalAnchor,
      range: {
        start: { line: 10, character: 1 },
        end: { line: 10, character: 4 },
      },
      selectedText: "value",
      beforeContext: ["before"],
      afterContext: ["after"],
    };

    expect(buildHistoricalDocument(thread)).toEqual({
      content: "before\nvalue\nafter",
      range: {
        start: { line: 1, character: 1 },
        end: { line: 1, character: 4 },
      },
    });
  });
});

function createThread(): ReviewThread {
  const now = "2026-01-01T00:00:00.000Z";
  const range = {
    start: { line: 2, character: 0 },
    end: { line: 2, character: 0 },
  };
  const anchor = {
    filePath: "src/platform/hash.ts",
    range,
    selectedText: "",
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
    anchorHistory: [
      {
        kind: "created",
        at: now,
        toRange: range,
      },
    ],
    diffContext: {
      header: "header",
      hunk: [
        "@@ -0,0 +1,5 @@",
        '+import { createHash } from "node:crypto";',
        "+",
        "+export function sha256(value: string): string {",
        '+  return createHash("sha256").update(value).digest("hex");',
        "+}",
      ].join("\n"),
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 5,
    },
    messages: [
      {
        id: "message-1",
        author: "user",
        body: "Test comment",
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
