import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type {
  AnchorSnapshot,
  RepositoryIdentity,
  ReviewThread,
} from "@revloop/shared";
import {
  createRepositoryResolver,
  createReviewServer,
  createReviewToolHandlers,
} from "../src/reviewServer.js";

describe("MCP review server", () => {
  it("registers the Revloop tools", () => {
    expect(createReviewServer()).toBeDefined();
  });

  it("caches repositories by absolute root", async () => {
    const repository = createRepository();
    const factory = vi.fn(() => Promise.resolve(repository));
    const resolveRepository = createRepositoryResolver(factory);

    await resolveRepository("/workspace/repository");
    await resolveRepository("/workspace/repository");
    await resolveRepository("/workspace/other");

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("serializes read and reply tool results", async () => {
    const repository = createRepository();
    const handlers = createReviewToolHandlers(() =>
      Promise.resolve(repository),
    );

    const read = parseTextResult(
      await handlers.readComments({
        repositoryRoot: "/workspace/repository",
        filePath: "src/index.ts",
      }),
    );
    expect(repository.readComments).toHaveBeenCalledWith(
      "open",
      "src/index.ts",
    );
    expect(read).toMatchObject({
      branch: "refs/heads/main",
      count: 1,
      threads: [
        {
          id: "thread-1",
          selectedExcerpt: "value",
        },
      ],
    });

    const reply = parseTextResult(
      await handlers.replyToComment({
        repositoryRoot: "/workspace/repository",
        threadId: "thread-1",
        body: "Updated.",
        outcome: "changed",
      }),
    );
    expect(repository.replyToComment).toHaveBeenCalledWith(
      "thread-1",
      "Updated.",
      "changed",
    );
    expect(reply).toEqual({
      branch: "refs/heads/main",
      threadId: "thread-1",
      replyId: "reply-1",
      status: "open",
    });
  });

  it("validates tool arguments before repository access", async () => {
    const repository = createRepository();
    const factory = vi.fn(() => Promise.resolve(repository));
    const server = createReviewServer(factory);
    const client = new Client({
      name: "revloop-contract-test",
      version: "0.0.1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const repositoryRoot = path.resolve("/workspace/repository");

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(
        await client.callTool({
          name: "read_comments",
          arguments: {
            repositoryRoot: "relative/repository",
          },
        }),
      ).toMatchObject({ isError: true });
      expect(
        await client.callTool({
          name: "read_comments",
          arguments: {
            repositoryRoot,
            filePath: "../outside.ts",
          },
        }),
      ).toMatchObject({ isError: true });
      expect(
        await client.callTool({
          name: "reply_to_comment",
          arguments: {
            repositoryRoot,
            threadId: "thread-1",
            body: "   ",
          },
        }),
      ).toMatchObject({ isError: true });
      expect(factory).not.toHaveBeenCalled();

      expect(
        await client.callTool({
          name: "read_comments",
          arguments: {
            repositoryRoot,
            filePath: "src/index.ts",
          },
        }),
      ).not.toMatchObject({ isError: true });
      expect(
        await client.callTool({
          name: "reply_to_comment",
          arguments: {
            repositoryRoot,
            threadId: "thread-1",
            body: "Updated.",
          },
        }),
      ).not.toMatchObject({ isError: true });
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function createRepository() {
  const identity: RepositoryIdentity = {
    key: "repository",
    rootPath: "/workspace/repository",
    displayName: "repository",
    storageRoot: "/workspace/repository/.git/revloop",
  };
  const thread = createThread();
  return {
    readComments: vi.fn(() =>
      Promise.resolve({
        repository: identity,
        branch: thread.branch,
        threads: [thread],
      }),
    ),
    replyToComment: vi.fn(() =>
      Promise.resolve({
        branch: thread.branch,
        thread,
        replyId: "reply-1",
      }),
    ),
  };
}

function createThread(): ReviewThread {
  const now = "2026-01-01T00:00:00.000Z";
  const anchor: AnchorSnapshot = {
    filePath: "src/index.ts",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    selectedText: "value",
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
    status: "open",
    originalAnchor: anchor,
    currentAnchor: anchor,
    anchorHistory: [{ kind: "created", at: now }],
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

function parseTextResult(result: {
  content: [{ type: "text"; text: string }];
}): unknown {
  return JSON.parse(result.content[0].text) as unknown;
}
