import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrentReviewStateError,
  JsonReviewStore,
  ReviewMessageEditConflictError,
} from "@revloop/shared";
import type {
  AnchorSnapshot,
  BranchReviewState,
  RepositoryIdentity,
  ReviewThread,
} from "@revloop/shared";
import {
  StaleThreadRepositoryContextError,
  ThreadRepository,
} from "../../src/storage/threadRepository.js";

const temporaryDirectories: string[] = [];
const repositories: ThreadRepository[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const repository of repositories.splice(0)) {
    repository.dispose();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("thread repository", () => {
  it("supports the complete user thread lifecycle", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const threads = new ThreadRepository(store);
    repositories.push(threads);

    expect(threads.list()).toEqual([]);
    expect(() => threads.repository).toThrow(
      "Thread repository has not been opened.",
    );
    expect(() => threads.captureContext()).toThrow(
      StaleThreadRepositoryContextError,
    );

    await threads.open(repository, "refs/heads/main");
    const listener = vi.fn();
    const subscription = threads.onDidChange(listener);
    const created = await threads.create(
      createThreadInput("src/index.ts", "Please change this."),
    );
    await threads.appendUserReply(created.id, "One more detail.");
    await threads.updateAnchor(
      created.id,
      {
        ...created.originalAnchor,
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 5 },
        },
      },
      "edited",
      0.8,
    );
    await threads.markOutdated(created.id, "The file moved.");
    await threads.resolve(created.id);
    await threads.reopen(created.id);

    expect(threads.get(created.id)?.messages).toHaveLength(2);
    expect(listener).toHaveBeenCalled();
    subscription.dispose();
    await expect(
      threads.appendUserReply("missing-thread", "Missing."),
    ).rejects.toThrow("Unknown review thread: missing-thread");
  });

  it("persists edits to user-authored messages", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const threads = new ThreadRepository(store);
    repositories.push(threads);
    await threads.open(repository, "refs/heads/main");
    const created = await threads.create(
      createThreadInput("src/index.ts", "Please change this."),
    );
    const message = created.messages[0];
    if (message === undefined) {
      throw new Error("Expected an initial review message.");
    }

    const edited = await threads.editUserMessage(
      created.id,
      message.id,
      "Please change the name instead.",
      message.body,
    );

    const persisted = await store.loadBranch(repository, "refs/heads/main");
    expect(edited.body).toBe("Please change the name instead.");
    expect(persisted.threads[0]?.messages[0]?.body).toBe(
      "Please change the name instead.",
    );
  });

  it("rejects concurrent edits to the same message", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const first = new ThreadRepository(store);
    const second = new ThreadRepository(store);
    repositories.push(first, second);
    await first.open(repository, "refs/heads/main");
    const created = await first.create(
      createThreadInput("src/index.ts", "Please change this."),
    );
    await second.open(repository, "refs/heads/main");
    const message = created.messages[0];
    if (message === undefined) {
      throw new Error("Expected an initial review message.");
    }

    await first.editUserMessage(
      created.id,
      message.id,
      "Use the first name.",
      message.body,
    );
    await expect(
      second.editUserMessage(
        created.id,
        message.id,
        "Use the second name.",
        message.body,
      ),
    ).rejects.toBeInstanceOf(ReviewMessageEditConflictError);

    const persisted = await store.loadBranch(repository, "refs/heads/main");
    expect(persisted.threads[0]?.messages[0]?.body).toBe("Use the first name.");
  });

  it("persists branch-scoped threads", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const first = new ThreadRepository(store);
    repositories.push(first);
    await first.open(repository, "refs/heads/main");
    const created = await first.create({
      filePath: "src/index.ts",
      languageId: "typescript",
      anchor: createAnchor(),
      diffContext: {
        header: "header",
        hunk: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
      },
      body: "Please change this.",
    });

    const second = new ThreadRepository(store);
    repositories.push(second);
    await second.open(repository, "refs/heads/main");
    expect(second.get(created.id)?.messages[0]?.body).toBe(
      "Please change this.",
    );

    await second.open(repository, "refs/heads/other");
    expect(second.list()).toEqual([]);
  });

  it("retries conflicts against freshly loaded state", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const first = new ThreadRepository(store);
    const second = new ThreadRepository(store);
    repositories.push(first, second);
    await first.open(repository, "refs/heads/main");
    await second.open(repository, "refs/heads/main");

    await first.create(createThreadInput("src/first.ts", "First change."));
    await second.create(createThreadInput("src/second.ts", "Second change."));

    const persisted = await store.loadBranch(repository, "refs/heads/main");
    expect(persisted.threads.map((thread) => thread.filePath).sort()).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
    expect(persisted.revision).toBe(2);
  });

  it("bounds repeated concurrent-state retries", async () => {
    const repositoryIdentity = createRepository("/workspace/storage");
    const state = createState(repositoryIdentity, "refs/heads/main", 0, []);
    const store = {
      loadBranch: vi.fn(() => Promise.resolve(structuredClone(state))),
      pruneBranchStates: vi.fn(() => Promise.resolve()),
      saveBranch: vi.fn(() =>
        Promise.reject(
          new ConcurrentReviewStateError("/workspace/review.json"),
        ),
      ),
    };
    const threads = new ThreadRepository(store);
    repositories.push(threads);
    await threads.open(repositoryIdentity, state.branch);

    await expect(
      threads.create(createThreadInput("src/index.ts", "Please change this.")),
    ).rejects.toBeInstanceOf(ConcurrentReviewStateError);
    expect(store.saveBranch).toHaveBeenCalledTimes(3);
    expect(store.loadBranch).toHaveBeenCalledTimes(3);
  });

  it("skips persistence for true no-op mutations", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const threads = new ThreadRepository(store);
    repositories.push(threads);
    await threads.open(repository, "refs/heads/main");
    const created = await threads.create(
      createThreadInput("src/index.ts", "Please change this."),
    );
    await threads.resolve(created.id);
    const resolved = await store.loadBranch(repository, "refs/heads/main");

    await threads.resolve(created.id);

    const afterNoOp = await store.loadBranch(repository, "refs/heads/main");
    expect(afterNoOp.revision).toBe(resolved.revision);
  });

  it("does not persist anchor-only file hash changes", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const threads = new ThreadRepository(store);
    repositories.push(threads);
    await threads.open(repository, "refs/heads/main");
    const created = await threads.create(
      createThreadInput("src/index.ts", "Please change this."),
    );
    const before = await store.loadBranch(repository, "refs/heads/main");

    await threads.updateAnchor(
      created.id,
      {
        ...created.originalAnchor,
        contentHash: "new-whole-file-hash",
        capturedAt: "2026-01-01T00:02:00.000Z",
      },
      "edited",
      1,
    );

    const after = await store.loadBranch(repository, "refs/heads/main");
    expect(after.revision).toBe(before.revision);
    expect(after.threads[0]?.anchorHistory).toHaveLength(1);
  });

  it("fences an in-flight poll when a different branch opens", async () => {
    vi.useFakeTimers();
    const repositoryIdentity = createRepository("/workspace/storage");
    const branchA = createState(repositoryIdentity, "refs/heads/main", 0, []);
    const staleBranchA = createState(repositoryIdentity, "refs/heads/main", 1, [
      createThread("stale-thread", "refs/heads/main"),
    ]);
    const branchB = createState(repositoryIdentity, "refs/heads/feature", 0, [
      createThread("feature-thread", "refs/heads/feature"),
    ]);
    let resolvePoll: ((state: BranchReviewState) => void) | undefined;
    let mainLoads = 0;
    const store = {
      loadBranch: vi.fn(
        (
          _repository: RepositoryIdentity,
          branch: string,
        ): Promise<BranchReviewState> => {
          if (branch === branchB.branch) {
            return Promise.resolve(structuredClone(branchB));
          }
          mainLoads += 1;
          if (mainLoads === 1) {
            return Promise.resolve(structuredClone(branchA));
          }
          return new Promise((resolve) => {
            resolvePoll = resolve;
          });
        },
      ),
      pruneBranchStates: vi.fn(() => Promise.resolve()),
      saveBranch: vi.fn(),
    };
    const threads = new ThreadRepository(store);
    repositories.push(threads);
    const emissions: string[][] = [];
    threads.onDidChange((current) => {
      emissions.push(current.map((thread) => thread.id));
    });
    await threads.open(repositoryIdentity, branchA.branch);

    await vi.advanceTimersByTimeAsync(500);
    const openFeature = threads.open(repositoryIdentity, branchB.branch);
    resolvePoll?.(structuredClone(staleBranchA));
    await openFeature;

    expect(threads.branch).toBe(branchB.branch);
    expect(emissions).not.toContainEqual(["stale-thread"]);
    expect(emissions.at(-1)).toEqual(["feature-thread"]);
  });

  it("rejects stale anchor writes after suspension", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const threads = new ThreadRepository(store);
    repositories.push(threads);
    await threads.open(repository, "refs/heads/main");
    const created = await threads.create(
      createThreadInput("src/index.ts", "Please change this."),
    );
    const context = threads.captureContext();

    threads.suspend();

    await expect(
      threads.updateAnchor(
        created.id,
        { ...createAnchor(), contentHash: "changed" },
        "edited",
        1,
        context,
      ),
    ).rejects.toBeInstanceOf(StaleThreadRepositoryContextError);
  });

  it("does not let a stale context suspend a newer branch", async () => {
    const directory = await createTemporaryDirectory();
    temporaryDirectories.push(directory);
    const store = new JsonReviewStore();
    const repository = createRepository(directory);
    const threads = new ThreadRepository(store);
    repositories.push(threads);

    const mainContext = await threads.open(repository, "refs/heads/main");
    const featureContext = await threads.open(repository, "refs/heads/feature");

    expect(mainContext).toBeDefined();
    expect(featureContext).toBeDefined();
    expect(threads.suspend(mainContext)).toBe(false);
    expect(threads.captureContext()).toEqual(featureContext);
    expect(threads.suspend(featureContext)).toBe(true);
  });
});

function createAnchor(): AnchorSnapshot {
  return {
    filePath: "src/index.ts",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    selectedText: "value",
    beforeContext: [],
    afterContext: [],
    contentHash: "hash",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(process.cwd(), ".revloop-repository-"));
}

function createRepository(storageRoot: string): RepositoryIdentity {
  return {
    key: "repo-key",
    rootPath: "/workspace/project",
    displayName: "project",
    storageRoot,
  };
}

function createThreadInput(filePath: string, body: string) {
  return {
    filePath,
    languageId: "typescript",
    anchor: {
      ...createAnchor(),
      filePath,
    },
    diffContext: {
      header: "header",
      hunk: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    },
    body,
  };
}

function createState(
  repository: RepositoryIdentity,
  branch: string,
  revision: number,
  threads: ReviewThread[],
): BranchReviewState {
  return {
    schemaVersion: 1,
    revision,
    repository,
    branch,
    threads,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createThread(id: string, branch: string): ReviewThread {
  const anchor = createAnchor();
  return {
    id,
    repositoryKey: "repo-key",
    branch,
    filePath: anchor.filePath,
    languageId: "typescript",
    status: "open",
    originalAnchor: anchor,
    currentAnchor: anchor,
    anchorHistory: [
      {
        kind: "created",
        at: "2026-01-01T00:00:00.000Z",
        toRange: anchor.range,
      },
    ],
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
        body: "Review this.",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
