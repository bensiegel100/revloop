import { describe, expect, it } from "vitest";
import {
  appendExternalAgentMessage,
  appendUserMessage,
  createReviewThread,
  editUserMessage,
  markThreadOutdated,
  reopenThread,
  ReviewMessageEditConflictError,
  resolveThread,
  updateThreadAnchor,
} from "../../src/domain/threadState.js";
import type { AnchorSnapshot, NewThreadInput } from "../../src/domain/types.js";

describe("thread state", () => {
  it("appends validated user replies and treats identical edits as no-ops", () => {
    const thread = createThread();
    const reply = appendUserMessage(
      thread,
      "  Follow up on this.  ",
      "2026-01-01T00:01:00.000Z",
      "reply-message",
    );
    const initial = thread.messages[0];
    if (initial === undefined) {
      throw new Error("Expected an initial review message.");
    }

    expect(reply.body).toBe("Follow up on this.");
    expect(() => appendUserMessage(thread, "   ")).toThrow(
      "Review messages cannot be empty.",
    );
    expect(() =>
      editUserMessage(thread, "missing-message", "Updated.", "Original."),
    ).toThrow("Unknown review message: missing-message");

    const updatedAt = thread.updatedAt;
    expect(
      editUserMessage(
        thread,
        initial.id,
        initial.body,
        initial.body,
        "2026-01-01T00:02:00.000Z",
      ),
    ).toBe(initial);
    expect(thread.updatedAt).toBe(updatedAt);
  });

  it("edits user-authored messages without changing their identity", () => {
    const thread = createThread();
    const message = thread.messages[0];
    if (message === undefined) {
      throw new Error("Expected an initial review message.");
    }

    const edited = editUserMessage(
      thread,
      message.id,
      "  Please revisit the naming.  ",
      message.body,
      "2026-01-01T00:02:00.000Z",
    );

    expect(edited.id).toBe(message.id);
    expect(edited.body).toBe("Please revisit the naming.");
    expect(edited.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(thread.updatedAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("rejects edits to agent-authored messages", () => {
    const thread = createThread();
    const message = appendExternalAgentMessage(
      thread,
      "Changed the implementation.",
      "changed",
      "2026-01-01T00:01:00.000Z",
      "agent-message",
    );

    expect(() =>
      editUserMessage(thread, message.id, "Different response.", message.body),
    ).toThrow("Only user-authored review messages can be edited.");
  });

  it("rejects edits when the persisted message changed", () => {
    const thread = createThread();
    const message = thread.messages[0];
    if (message === undefined) {
      throw new Error("Expected an initial review message.");
    }
    const originalBody = message.body;
    message.body = "Changed elsewhere.";

    expect(() =>
      editUserMessage(thread, message.id, "My pending edit.", originalBody),
    ).toThrow(ReviewMessageEditConflictError);
  });

  it("appends an agent reply without changing resolution", () => {
    const thread = createThread();
    const message = appendExternalAgentMessage(
      thread,
      "Changed the implementation.",
      "changed",
      "2026-01-01T00:01:00.000Z",
      "agent-message",
    );

    expect(message.outcome).toBe("changed");
    expect(thread.status).toBe("open");
  });

  it("keeps resolution as an explicit user state", () => {
    const thread = createThread();
    resolveThread(thread, "2026-01-01T00:01:00.000Z");
    expect(thread.status).toBe("resolved");

    appendExternalAgentMessage(
      thread,
      "Answered the question.",
      "answered",
      "2026-01-01T00:03:00.000Z",
      "agent-message",
    );
    expect(thread.status).toBe("resolved");

    reopenThread(thread, "2026-01-01T00:04:00.000Z");
    expect(thread.status).toBe("open");
  });

  it("reopens resolved outdated threads without changing open threads", () => {
    const thread = createThread();
    const updatedAt = thread.updatedAt;
    reopenThread(thread, "2026-01-01T00:01:00.000Z");
    expect(thread.updatedAt).toBe(updatedAt);

    markThreadOutdated(
      thread,
      "The original file no longer exists.",
      "2026-01-01T00:02:00.000Z",
    );
    resolveThread(thread, "2026-01-01T00:03:00.000Z");
    resolveThread(thread, "2026-01-01T00:04:00.000Z");
    reopenThread(thread, "2026-01-01T00:05:00.000Z");

    expect(thread.status).toBe("outdated");
    expect(thread.resolvedAt).toBeUndefined();
  });

  it("records anchor changes and restores outdated threads", () => {
    const thread = createThread();
    const movedAnchor: AnchorSnapshot = {
      ...thread.originalAnchor,
      range: {
        start: { line: 4, character: 2 },
        end: { line: 4, character: 14 },
      },
      selectedText: "const y = 2;",
      capturedAt: "2026-01-01T00:01:00.000Z",
    };

    updateThreadAnchor(
      thread,
      movedAnchor,
      "remapped",
      0.9,
      "2026-01-01T00:01:00.000Z",
    );
    markThreadOutdated(thread, "The anchor moved.", "2026-01-01T00:02:00.000Z");
    updateThreadAnchor(
      thread,
      {
        ...movedAnchor,
        range: {
          start: { line: 6, character: 0 },
          end: { line: 6, character: 12 },
        },
      },
      "edited",
      undefined,
      "2026-01-01T00:03:00.000Z",
    );

    expect(thread.status).toBe("open");
    expect(thread.anchorHistory[1]).toMatchObject({
      kind: "remapped",
      fromRange: thread.originalAnchor.range,
      toRange: movedAnchor.range,
      confidence: 0.9,
    });
    expect(thread.anchorHistory.at(-1)).toMatchObject({
      kind: "edited",
      toRange: {
        start: { line: 6, character: 0 },
        end: { line: 6, character: 12 },
      },
    });
  });

  it("does not duplicate identical outdated history entries", () => {
    const thread = createThread();
    markThreadOutdated(
      thread,
      "The original file no longer exists.",
      "2026-01-01T00:01:00.000Z",
    );
    markThreadOutdated(
      thread,
      "The original file no longer exists.",
      "2026-01-01T00:02:00.000Z",
    );

    expect(
      thread.anchorHistory.filter((event) => event.kind === "outdated"),
    ).toHaveLength(1);
  });

  it("does not record an anchor update when location and context are unchanged", () => {
    const thread = createThread();
    const originalUpdatedAt = thread.updatedAt;
    updateThreadAnchor(
      thread,
      {
        ...thread.originalAnchor,
        contentHash: "new-whole-file-hash",
        capturedAt: "2026-01-01T00:02:00.000Z",
      },
      "edited",
      1,
      "2026-01-01T00:02:00.000Z",
    );

    expect(thread.anchorHistory).toHaveLength(1);
    expect(thread.updatedAt).toBe(originalUpdatedAt);
    expect(thread.currentAnchor).toEqual(thread.originalAnchor);
  });
});

function createThread() {
  const anchor: AnchorSnapshot = {
    filePath: "src/example.ts",
    range: {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 12 },
    },
    selectedText: "const x = 1;",
    beforeContext: ["function run() {"],
    afterContext: ["}"],
    contentHash: "hash",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
  const input: NewThreadInput = {
    filePath: anchor.filePath,
    languageId: "typescript",
    anchor,
    diffContext: {
      header: "diff --git a/src/example.ts b/src/example.ts",
      hunk: "@@ -1,3 +1,3 @@",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
    },
    body: "Please revisit this.",
  };
  return createReviewThread(input, {
    repositoryKey: "repository",
    branch: "refs/heads/main",
    now: "2026-01-01T00:00:00.000Z",
    id: "thread-1",
    messageId: "user-message",
  });
}
