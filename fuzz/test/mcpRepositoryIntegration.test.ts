import {
  createGitRepositoryFixture,
  fuzzParameters,
  nonBlankTextArbitrary,
  repositoryRelativePathArbitrary,
  reviewThreadsArbitrary,
} from "../src/index.js";
import {
  JsonReviewStore,
  normalizeRepositoryRelativePath,
} from "@revloop/shared";
import type {
  AgentReplyOutcome,
  ReviewThread,
  ReviewThreadStatus,
} from "@revloop/shared";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { McpReviewRepository } from "../../mcp/src/reviewRepository.js";
import type { CommentStatusFilter } from "../../mcp/src/reviewRepository.js";

interface ReadScenario {
  readonly threads: readonly ReviewThread[];
  readonly status: CommentStatusFilter;
  readonly filePath?: string;
}

interface ReplyScenario {
  readonly threads: readonly ReviewThread[];
  readonly threadIndex: number;
  readonly body: string;
  readonly outcome?: AgentReplyOutcome;
}

interface ConcurrentReplyScenario {
  readonly threads: readonly ReviewThread[];
  readonly first: {
    readonly threadIndex: number;
    readonly body: string;
    readonly outcome?: AgentReplyOutcome;
  };
  readonly second: {
    readonly threadIndex: number;
    readonly body: string;
    readonly outcome?: AgentReplyOutcome;
  };
}

const commentStatusArbitrary = fc.constantFrom<CommentStatusFilter>(
  "open",
  "outdated",
  "resolved",
  "unresolved",
  "all",
);
const outcomeArbitrary = fc.constantFrom<AgentReplyOutcome>(
  "changed",
  "answered",
  "declined",
  "blocked",
);

describe("MCP repository integration fuzzing", () => {
  it("reads generated persisted threads through Git-discovered repository state", async () => {
    const fixture = await createGitRepositoryFixture();
    try {
      const repository = await McpReviewRepository.fromWorkingDirectory(
        fixture.nestedPath,
      );
      const scenarioArbitrary = reviewThreadsArbitrary(
        fixture.repository.key,
        fixture.branchRef,
        { maxLength: 8 },
      ).chain((threads) =>
        fc
          .record({
            status: commentStatusArbitrary,
            filterKind: fc.constantFrom("none", "existing", "generated"),
            threadIndex: fc.nat(),
            generatedPath: repositoryRelativePathArbitrary,
            useBackslashes: fc.boolean(),
          })
          .map(
            ({
              status,
              filterKind,
              threadIndex,
              generatedPath,
              useBackslashes,
            }): ReadScenario => {
              let filePath: string | undefined;
              if (filterKind === "existing" && threads.length > 0) {
                filePath = threads[threadIndex % threads.length]?.filePath;
              } else if (filterKind === "generated") {
                filePath = generatedPath;
              }
              if (filePath !== undefined && useBackslashes) {
                filePath = filePath.replaceAll("/", "\\");
              }

              return {
                threads,
                status,
                ...(filePath === undefined ? {} : { filePath }),
              };
            },
          ),
      );

      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async (scenario) => {
          await persistThreads(fixture, scenario.threads);

          const result = await repository.readComments(
            scenario.status,
            scenario.filePath,
          );

          expect(result.repository).toEqual(fixture.repository);
          expect(result.branch).toBe(fixture.branchRef);
          expect(result.threads).toEqual(
            expectedThreads(
              scenario.threads,
              scenario.status,
              scenario.filePath,
            ),
          );
        }),
        fuzzParameters(),
      );
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("persists generated agent replies without changing thread status", async () => {
    const fixture = await createGitRepositoryFixture();
    try {
      const repository = await McpReviewRepository.fromWorkingDirectory(
        fixture.rootPath,
      );
      const scenarioArbitrary = reviewThreadsArbitrary(
        fixture.repository.key,
        fixture.branchRef,
        { minLength: 1, maxLength: 6 },
      ).chain((threads) =>
        fc
          .record({
            threadIndex: fc.nat(),
            body: nonBlankTextArbitrary,
            outcome: fc.option(outcomeArbitrary, { nil: null }),
          })
          .map(({ threadIndex, body, outcome }): ReplyScenario => ({
            threads,
            threadIndex,
            body,
            ...(outcome === null ? {} : { outcome }),
          })),
      );

      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async (scenario) => {
          await persistThreads(fixture, scenario.threads);
          const target =
            scenario.threads[scenario.threadIndex % scenario.threads.length];
          if (target === undefined) {
            throw new Error("Reply scenario requires a target thread.");
          }

          const result = await repository.replyToComment(
            target.id,
            scenario.body,
            scenario.outcome,
          );
          const persisted = await loadThreads(fixture);
          const persistedTarget = persisted.find(
            (thread) => thread.id === target.id,
          );
          const reply = persistedTarget?.messages.find(
            (message) => message.id === result.replyId,
          );

          expect(result.branch).toBe(fixture.branchRef);
          expect(result.thread.status).toBe(target.status);
          expect(persistedTarget?.status).toBe(target.status);
          expect(persistedTarget?.messages).toHaveLength(
            target.messages.length + 1,
          );
          expect(reply).toMatchObject({
            author: "agent",
            body: scenario.body.trim(),
            ...(scenario.outcome === undefined
              ? {}
              : { outcome: scenario.outcome }),
          });
        }),
        fuzzParameters(),
      );
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("preserves both generated replies during concurrent repository writes", async () => {
    const fixture = await createGitRepositoryFixture();
    try {
      const firstRepository = await McpReviewRepository.fromWorkingDirectory(
        fixture.rootPath,
      );
      const secondRepository = await McpReviewRepository.fromWorkingDirectory(
        fixture.nestedPath,
      );
      const replyInputArbitrary = fc
        .record({
          threadIndex: fc.nat(),
          body: nonBlankTextArbitrary,
          outcome: fc.option(outcomeArbitrary, { nil: null }),
        })
        .map(({ threadIndex, body, outcome }) => ({
          threadIndex,
          body,
          ...(outcome === null ? {} : { outcome }),
        }));
      const scenarioArbitrary = reviewThreadsArbitrary(
        fixture.repository.key,
        fixture.branchRef,
        { minLength: 1, maxLength: 6 },
      ).chain((threads) =>
        fc
          .tuple(replyInputArbitrary, replyInputArbitrary)
          .map(([first, second]): ConcurrentReplyScenario => ({
            threads,
            first,
            second,
          })),
      );

      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async (scenario) => {
          await persistThreads(fixture, scenario.threads);
          const firstTarget =
            scenario.threads[
              scenario.first.threadIndex % scenario.threads.length
            ];
          const secondTarget =
            scenario.threads[
              scenario.second.threadIndex % scenario.threads.length
            ];
          if (firstTarget === undefined || secondTarget === undefined) {
            throw new Error(
              "Concurrent reply scenario requires target threads.",
            );
          }

          const [firstResult, secondResult] = await Promise.all([
            firstRepository.replyToComment(
              firstTarget.id,
              scenario.first.body,
              scenario.first.outcome,
            ),
            secondRepository.replyToComment(
              secondTarget.id,
              scenario.second.body,
              scenario.second.outcome,
            ),
          ]);
          const persisted = await loadThreads(fixture);
          const messages = persisted.flatMap((thread) => thread.messages);

          expect(messages).toHaveLength(
            scenario.threads.reduce(
              (count, thread) => count + thread.messages.length,
              2,
            ),
          );
          expect(
            messages.find((message) => message.id === firstResult.replyId),
          ).toMatchObject({
            author: "agent",
            body: scenario.first.body.trim(),
          });
          expect(
            messages.find((message) => message.id === secondResult.replyId),
          ).toMatchObject({
            author: "agent",
            body: scenario.second.body.trim(),
          });
          expect(
            persisted.map((thread) => ({
              id: thread.id,
              status: thread.status,
            })),
          ).toEqual(
            scenario.threads.map((thread) => ({
              id: thread.id,
              status: thread.status,
            })),
          );
        }),
        fuzzParameters(),
      );
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});

async function persistThreads(
  fixture: Awaited<ReturnType<typeof createGitRepositoryFixture>>,
  threads: readonly ReviewThread[],
): Promise<void> {
  await fixture.resetReviewState();
  const store = new JsonReviewStore();
  const state = await store.loadBranch(fixture.repository, fixture.branchRef);
  state.threads = structuredClone([...threads]);
  await store.saveBranch(state, state.revision);
}

async function loadThreads(
  fixture: Awaited<ReturnType<typeof createGitRepositoryFixture>>,
): Promise<readonly ReviewThread[]> {
  return (
    await new JsonReviewStore().loadBranch(
      fixture.repository,
      fixture.branchRef,
    )
  ).threads;
}

function expectedThreads(
  threads: readonly ReviewThread[],
  status: CommentStatusFilter,
  filePath?: string,
): readonly ReviewThread[] {
  const normalizedPath =
    filePath === undefined
      ? undefined
      : normalizeRepositoryRelativePath(filePath);
  return threads.filter(
    (thread) =>
      matchesStatus(thread.status, status) &&
      (normalizedPath === undefined || thread.filePath === normalizedPath),
  );
}

function matchesStatus(
  threadStatus: ReviewThreadStatus,
  filter: CommentStatusFilter,
): boolean {
  return (
    filter === "all" ||
    (filter === "unresolved" && threadStatus !== "resolved") ||
    threadStatus === filter
  );
}
