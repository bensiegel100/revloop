import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  absoluteRepositoryRootArbitrary,
  branchRefArbitrary,
  fuzzParameters,
  nonBlankTextArbitrary,
  repositoryRelativePathArbitrary,
  reviewThreadArbitrary,
  safePathSegmentArbitrary,
} from "../src/index.js";
import { createReviewThread } from "@revloop/shared";
import type {
  AnchorSnapshot,
  RepositoryIdentity,
  ReviewThread,
} from "@revloop/shared";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createRepositoryResolver,
  createReviewServer,
} from "../../mcp/src/reviewServer.js";

type CommentStatus = "open" | "outdated" | "resolved" | "unresolved" | "all";
type ReplyOutcome = "changed" | "answered" | "declined" | "blocked";
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface ReadScenario {
  readonly repositoryRoot: string;
  readonly status?: CommentStatus;
  readonly filePath?: string;
  readonly repository: RepositoryIdentity;
  readonly branch: string;
  readonly threads: readonly ReviewThread[];
}

interface ReplyScenario {
  readonly repositoryRoot: string;
  readonly threadId: string;
  readonly body: string;
  readonly outcome?: ReplyOutcome;
  readonly branch: string;
  readonly thread: ReviewThread;
  readonly replyId: string;
}

interface InvalidToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface ReadCall {
  readonly status: CommentStatus;
  readonly filePath?: string;
}

interface ReplyCall {
  readonly threadId: string;
  readonly body: string;
  readonly outcome?: ReplyOutcome;
}

class RecordingRepository {
  public readonly readCalls: ReadCall[] = [];
  public readonly replyCalls: ReplyCall[] = [];

  public constructor(
    private readonly readResult: {
      repository: RepositoryIdentity;
      branch: string;
      threads: readonly ReviewThread[];
    },
    private readonly replyResult: {
      branch: string;
      thread: ReviewThread;
      replyId: string;
    },
  ) {}

  public readComments(
    status: CommentStatus,
    filePath?: string,
  ): Promise<{
    repository: RepositoryIdentity;
    branch: string;
    threads: readonly ReviewThread[];
  }> {
    this.readCalls.push({
      status,
      ...(filePath === undefined ? {} : { filePath }),
    });
    return Promise.resolve(structuredClone(this.readResult));
  }

  public replyToComment(
    threadId: string,
    body: string,
    outcome?: ReplyOutcome,
  ): Promise<{ branch: string; thread: ReviewThread; replyId: string }> {
    this.replyCalls.push({
      threadId,
      body,
      ...(outcome === undefined ? {} : { outcome }),
    });
    return Promise.resolve(structuredClone(this.replyResult));
  }
}

const commentStatusArbitrary = fc.constantFrom<CommentStatus>(
  "open",
  "outdated",
  "resolved",
  "unresolved",
  "all",
);
const outcomeArbitrary = fc.constantFrom<ReplyOutcome>(
  "changed",
  "answered",
  "declined",
  "blocked",
);
const readScenarioArbitrary: fc.Arbitrary<ReadScenario> = fc
  .tuple(
    absoluteRepositoryRootArbitrary,
    fc.option(commentStatusArbitrary, { nil: null }),
    fc.option(repositoryRelativePathArbitrary, { nil: null }),
    branchRefArbitrary,
    fc.uuid(),
    safePathSegmentArbitrary,
    fc.boolean(),
  )
  .chain(
    ([
      repositoryRoot,
      status,
      filePath,
      branch,
      repositoryKey,
      displayName,
      includeThread,
    ]) =>
      reviewThreadArbitrary(repositoryKey, branch).map((thread) => {
        const repository: RepositoryIdentity = {
          key: repositoryKey,
          rootPath: repositoryRoot,
          displayName,
          storageRoot: path.join(repositoryRoot, ".git", "revloop"),
        };
        return {
          repositoryRoot,
          ...(status === null ? {} : { status }),
          ...(filePath === null ? {} : { filePath }),
          repository,
          branch,
          threads: includeThread ? [thread] : [],
        };
      }),
  );
const replyScenarioArbitrary: fc.Arbitrary<ReplyScenario> = fc
  .tuple(
    absoluteRepositoryRootArbitrary,
    nonBlankTextArbitrary,
    fc.option(outcomeArbitrary, { nil: null }),
    branchRefArbitrary,
    fc.uuid(),
  )
  .chain(([repositoryRoot, body, outcome, branch, replyId]) =>
    reviewThreadArbitrary("repository", branch).map((thread) => ({
      repositoryRoot,
      threadId: thread.id,
      body,
      ...(outcome === null ? {} : { outcome }),
      branch,
      thread,
      replyId,
    })),
  );
const invalidRootArbitrary = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("relative/repository"),
  fc.integer(),
  fc.constant(null),
);
const invalidStatusArbitrary = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter(
    (value) =>
      !["open", "outdated", "resolved", "unresolved", "all"].includes(value),
  );
const invalidOutcomeArbitrary = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter(
    (value) => !["changed", "answered", "declined", "blocked"].includes(value),
  );
const invalidFilePathArbitrary = fc.constantFrom(
  "",
  "../outside.ts",
  "src//index.ts",
  "/absolute/index.ts",
  "C:\\absolute\\index.ts",
);
const invalidArgumentsCallArbitrary: fc.Arbitrary<InvalidToolCall> = fc.oneof(
  invalidRootArbitrary.map((repositoryRoot) => ({
    name: "read_comments",
    arguments: { repositoryRoot },
  })),
  fc
    .tuple(absoluteRepositoryRootArbitrary, invalidStatusArbitrary)
    .map(([repositoryRoot, status]) => ({
      name: "read_comments",
      arguments: { repositoryRoot, status },
    })),
  fc
    .tuple(absoluteRepositoryRootArbitrary, invalidFilePathArbitrary)
    .map(([repositoryRoot, filePath]) => ({
      name: "read_comments",
      arguments: { repositoryRoot, filePath },
    })),
  fc
    .tuple(absoluteRepositoryRootArbitrary, invalidOutcomeArbitrary)
    .map(([repositoryRoot, outcome]) => ({
      name: "reply_to_comment",
      arguments: {
        repositoryRoot,
        threadId: "thread",
        body: "Reply.",
        outcome,
      },
    })),
  fc
    .tuple(
      absoluteRepositoryRootArbitrary,
      fc.constantFrom("", "   "),
      nonBlankTextArbitrary,
    )
    .map(([repositoryRoot, threadId, body]) => ({
      name: "reply_to_comment",
      arguments: { repositoryRoot, threadId, body },
    })),
  fc
    .tuple(
      absoluteRepositoryRootArbitrary,
      fc.uuid(),
      fc.constantFrom("", " ", "\n\t"),
    )
    .map(([repositoryRoot, threadId, body]) => ({
      name: "reply_to_comment",
      arguments: { repositoryRoot, threadId, body },
    })),
);
const unknownToolCallArbitrary: fc.Arbitrary<InvalidToolCall> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((name) => name !== "read_comments" && name !== "reply_to_comment")
  .map((name) => ({
    name,
    arguments: {},
  }));

describe("MCP review server fuzzing", () => {
  it("preserves generated read_comments calls and results", async () => {
    await fc.assert(
      fc.asyncProperty(readScenarioArbitrary, async (scenario) => {
        const repository = new RecordingRepository(
          {
            repository: scenario.repository,
            branch: scenario.branch,
            threads: scenario.threads,
          },
          {
            branch: scenario.branch,
            thread:
              scenario.threads[0] ??
              createFallbackThread(scenario.repository.key, scenario.branch),
            replyId: "unused",
          },
        );

        await withClient(repository, async (client, factoryRoots) => {
          const result = await client.callTool({
            name: "read_comments",
            arguments: {
              repositoryRoot: scenario.repositoryRoot,
              ...(scenario.status === undefined
                ? {}
                : { status: scenario.status }),
              ...(scenario.filePath === undefined
                ? {}
                : { filePath: scenario.filePath }),
            },
          });

          expect(result.isError).not.toBe(true);
          expect(factoryRoots).toEqual([scenario.repositoryRoot]);
          expect(repository.readCalls).toEqual([
            {
              status: scenario.status ?? "open",
              ...(scenario.filePath === undefined
                ? {}
                : { filePath: scenario.filePath }),
            },
          ]);
          expect(parseTextResult(result)).toEqual({
            repository: scenario.repository,
            branch: scenario.branch,
            count: scenario.threads.length,
            threads: scenario.threads.map(toAgentThread),
          });
        });
      }),
      fuzzParameters(),
    );
  });

  it("preserves generated reply_to_comment calls and results", async () => {
    await fc.assert(
      fc.asyncProperty(replyScenarioArbitrary, async (scenario) => {
        const repository = new RecordingRepository(
          {
            repository: createRepositoryIdentity(scenario.repositoryRoot),
            branch: scenario.branch,
            threads: [scenario.thread],
          },
          {
            branch: scenario.branch,
            thread: scenario.thread,
            replyId: scenario.replyId,
          },
        );

        await withClient(repository, async (client, factoryRoots) => {
          const result = await client.callTool({
            name: "reply_to_comment",
            arguments: {
              repositoryRoot: scenario.repositoryRoot,
              threadId: scenario.threadId,
              body: scenario.body,
              ...(scenario.outcome === undefined
                ? {}
                : { outcome: scenario.outcome }),
            },
          });

          expect(result.isError).not.toBe(true);
          expect(factoryRoots).toEqual([scenario.repositoryRoot]);
          expect(repository.replyCalls).toEqual([
            {
              threadId: scenario.threadId,
              body: scenario.body,
              ...(scenario.outcome === undefined
                ? {}
                : { outcome: scenario.outcome }),
            },
          ]);
          expect(parseTextResult(result)).toEqual({
            branch: scenario.branch,
            threadId: scenario.threadId,
            replyId: scenario.replyId,
            status: scenario.thread.status,
          });
        });
      }),
      fuzzParameters(),
    );
  });

  it("rejects generated invalid tool calls before repository access", async () => {
    await fc.assert(
      fc.asyncProperty(invalidArgumentsCallArbitrary, async (call) => {
        const repository = createFallbackRepository();

        await withClient(repository, async (client, factoryRoots) => {
          const result = await client.callTool(call);
          expect(result.isError).toBe(true);
          expect(factoryRoots).toEqual([]);
          expect(repository.readCalls).toEqual([]);
          expect(repository.replyCalls).toEqual([]);
        });
      }),
      fuzzParameters(),
    );
  });

  it("rejects generated unknown tools before repository access", async () => {
    await fc.assert(
      fc.asyncProperty(unknownToolCallArbitrary, async (call) => {
        const repository = createFallbackRepository();

        await withClient(repository, async (client, factoryRoots) => {
          await expect(client.callTool(call)).rejects.toThrow();
          expect(factoryRoots).toEqual([]);
          expect(repository.readCalls).toEqual([]);
          expect(repository.replyCalls).toEqual([]);
        });
      }),
      fuzzParameters(),
    );
  });

  it("caches generated repository roots", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(absoluteRepositoryRootArbitrary, {
          minLength: 1,
          maxLength: 20,
        }),
        async (roots) => {
          const repository = createFallbackRepository();
          const factoryRoots: string[] = [];
          const resolveRepository = createRepositoryResolver(
            (repositoryRoot) => {
              factoryRoots.push(repositoryRoot);
              return Promise.resolve(repository);
            },
          );

          for (const repositoryRoot of roots) {
            await resolveRepository(repositoryRoot);
          }

          expect(factoryRoots).toEqual([...new Set(roots)]);
        },
      ),
      fuzzParameters(),
    );
  });
});

async function withClient<T>(
  repository: RecordingRepository,
  operation: (client: Client, factoryRoots: string[]) => Promise<T>,
): Promise<T> {
  const factoryRoots: string[] = [];
  const server = createReviewServer((repositoryRoot) => {
    factoryRoots.push(repositoryRoot);
    return Promise.resolve(repository);
  });
  const client = new Client({
    name: "revloop-contract-fuzzer",
    version: "0.0.1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await operation(client, factoryRoots);
  } finally {
    await client.close();
    await server.close();
  }
}

function toAgentThread(thread: ReviewThread): object {
  const anchor = thread.currentAnchor ?? thread.originalAnchor;
  return {
    id: thread.id,
    status: thread.status,
    filePath: thread.filePath,
    languageId: thread.languageId,
    currentRange: anchor.range,
    originalRange: thread.originalAnchor.range,
    selectedExcerpt: anchor.selectedText,
    diffContext: thread.diffContext,
    messages: thread.messages,
    anchorHistory: thread.anchorHistory,
  };
}

function createFallbackRepository(): RecordingRepository {
  const repository = createRepositoryIdentity(
    path.resolve(path.parse(process.cwd()).root, "fallback"),
  );
  const branch = "refs/heads/fallback";
  const thread = createFallbackThread(repository.key, branch);
  return new RecordingRepository(
    {
      repository,
      branch,
      threads: [thread],
    },
    {
      branch,
      thread,
      replyId: "fallback-reply",
    },
  );
}

function createRepositoryIdentity(repositoryRoot: string): RepositoryIdentity {
  return {
    key: "repository",
    rootPath: repositoryRoot,
    displayName: "repository",
    storageRoot: path.join(repositoryRoot, ".git", "revloop"),
  };
}

function createFallbackThread(
  repositoryKey: string,
  branch: string,
): ReviewThread {
  const now = "2020-01-01T00:00:00.000Z";
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
  return createReviewThread(
    {
      filePath: anchor.filePath,
      languageId: "typescript",
      anchor,
      diffContext: {
        header: "header",
        hunk: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
      },
      body: "Review this.",
    },
    {
      repositoryKey,
      branch,
      id: "fallback-thread",
      messageId: "fallback-message",
      now,
    },
  );
}

function parseTextResult(result: ToolResult): unknown {
  const content = result.content.find((item) => item.type === "text");
  if (content?.type !== "text") {
    throw new Error("MCP tool did not return text content.");
  }
  return JSON.parse(content.text) as unknown;
}
