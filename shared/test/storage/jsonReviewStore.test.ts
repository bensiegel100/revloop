import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../src/platform/hash.js";
import {
  ConcurrentReviewStateError,
  JsonReviewStore,
} from "../../src/storage/jsonReviewStore.js";
import { parseBranchReviewState } from "../../src/storage/schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("JSON review store migration", () => {
  it("migrates legacy VS Code storage into repository-local storage", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const legacyRoot = path.join(root, "legacy");
    const storageRoot = path.join(root, "git", "revloop");
    const repository = {
      key: "repo-key",
      rootPath: "/workspace/repository",
      displayName: "repository",
      storageRoot,
    };
    const branch = "refs/heads/main";
    const legacyFile = path.join(
      legacyRoot,
      "repositories",
      repository.key,
      "branches",
      `${sha256(branch)}.json`,
    );
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(
      legacyFile,
      `${JSON.stringify(createLegacyState(repository, branch), null, 2)}\n`,
      "utf8",
    );

    const store = new JsonReviewStore(legacyRoot);
    const migrated = await store.loadBranch(repository, branch);

    expect(migrated.threads[0]?.messages[0]?.body).toBe("Keep this comment.");
    expect(migrated.repository.storageRoot).toBe(storageRoot);

    const migratedFile = path.join(
      storageRoot,
      "branches",
      `${sha256(branch)}.json`,
    );
    const persisted: unknown = JSON.parse(await readFile(migratedFile, "utf8"));
    if (
      !isRecord(persisted) ||
      !isRecord(persisted.repository) ||
      typeof persisted.repository.storageRoot !== "string"
    ) {
      throw new Error("Migrated repository identity is invalid.");
    }
    expect(persisted.repository.storageRoot).toBe(storageRoot);
  });
});

describe("JSON review store validation", () => {
  it("preserves defined optional values", () => {
    const repository = createRepository("/tmp/revloop");
    const state = createLegacyState(repository, "refs/heads/main");
    const thread = state.threads[0];
    const historyEntry = thread?.anchorHistory[0];
    const message = thread?.messages[0];
    const range = historyEntry?.toRange;
    if (
      thread === undefined ||
      historyEntry === undefined ||
      message === undefined ||
      range === undefined
    ) {
      throw new Error("Expected a complete review thread.");
    }
    Reflect.set(thread, "resolvedAt", state.updatedAt);
    Reflect.set(historyEntry, "fromRange", range);
    Reflect.set(historyEntry, "confidence", 0.5);
    Reflect.set(historyEntry, "reason", "Moved with the selected code.");
    Reflect.set(message, "outcome", "answered");

    expect(parseBranchReviewState(state, repository).threads[0]).toMatchObject({
      resolvedAt: state.updatedAt,
      anchorHistory: [
        {
          fromRange: range,
          confidence: 0.5,
          reason: "Moved with the selected code.",
        },
      ],
      messages: [{ outcome: "answered" }],
    });
  });

  it("rejects non-finite optional numbers", () => {
    const repository = createRepository("/tmp/revloop");
    const state = createLegacyState(repository, "refs/heads/main");
    const historyEntry = state.threads[0]?.anchorHistory[0];
    if (historyEntry === undefined) {
      throw new Error("Expected an anchor history entry.");
    }
    Reflect.set(historyEntry, "confidence", Number.NaN);

    expect(() => parseBranchReviewState(state, repository)).toThrow(
      "review state.threads[0].anchorHistory[0].confidence",
    );
  });

  it("strips unknown fields and rejects explicitly undefined optionals", () => {
    const repository = createRepository("/tmp/revloop");
    const state = createLegacyState(repository, "refs/heads/main");
    const message = state.threads[0]?.messages[0];
    if (message === undefined) {
      throw new Error("Expected a review message.");
    }
    Reflect.set(message, "unexpected", true);

    const parsed = parseBranchReviewState(state, repository);
    expect(parsed.threads[0]?.messages[0]).not.toHaveProperty("unexpected");

    Reflect.set(message, "outcome", undefined);
    expect(() => parseBranchReviewState(state, repository)).toThrow(
      "review state.threads[0].messages[0].outcome",
    );
  });

  it("rejects malformed containers and required fields", () => {
    const repository = createRepository("/tmp/revloop");
    expect(() => parseBranchReviewState(null, repository)).toThrow(
      "Invalid review state at review state.",
    );

    const wrongVersion = createLegacyState(repository, "refs/heads/main");
    Reflect.set(wrongVersion, "schemaVersion", 2);
    expect(() => parseBranchReviewState(wrongVersion, repository)).toThrow(
      "review state.schemaVersion",
    );

    const noMessages = createLegacyState(repository, "refs/heads/main");
    const thread = noMessages.threads[0];
    if (thread === undefined) {
      throw new Error("Expected a review thread.");
    }
    thread.messages.splice(0);
    expect(() => parseBranchReviewState(noMessages, repository)).toThrow(
      "review state.threads[0].messages",
    );
  });
});

describe("JSON review store pruning", () => {
  it("removes only branch states that are not retained", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const retainedBranch = "refs/heads/main";
    const deletedBranch = "refs/heads/deleted";
    const store = new JsonReviewStore();

    const retainedState = await store.loadBranch(repository, retainedBranch);
    const deletedState = await store.loadBranch(repository, deletedBranch);
    await store.saveBranch(retainedState, retainedState.revision);
    await store.saveBranch(deletedState, deletedState.revision);
    const branchesDirectory = path.join(repository.storageRoot, "branches");
    const unrelatedFile = path.join(branchesDirectory, "notes.json");
    await writeFile(unrelatedFile, "{}\n", "utf8");

    await store.pruneBranchStates(repository, [retainedBranch]);
    expect(
      JSON.parse(
        await readFile(
          getBranchFile(repository.storageRoot, retainedBranch),
          "utf8",
        ),
      ) as unknown,
    ).toMatchObject({ branch: retainedBranch });
    await expect(
      readFile(getBranchFile(repository.storageRoot, deletedBranch), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelatedFile, "utf8")).resolves.toBe("{}\n");
  });

  it("does nothing before any branch state is persisted", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const repository = createRepository(root);

    await expect(
      new JsonReviewStore().pruneBranchStates(repository, []),
    ).resolves.toBeUndefined();
  });
});

describe("JSON review store concurrency", () => {
  it("allows only one simultaneous save for the same revision", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const branch = "refs/heads/main";
    const firstStore = new JsonReviewStore();
    const secondStore = new JsonReviewStore();
    const state = await firstStore.loadBranch(repository, branch);

    const results = await Promise.allSettled([
      firstStore.saveBranch(state, state.revision),
      secondStore.saveBranch(state, state.revision),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejection?.reason).toBeInstanceOf(ConcurrentReviewStateError);
  });

  it("reclaims a dead same-host lock before saving", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const branch = "refs/heads/main";
    const store = new JsonReviewStore();
    const state = await store.loadBranch(repository, branch);
    const branchFile = getBranchFile(repository.storageRoot, branch);
    const lockPath = `${branchFile}.lock`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        token: "dead-owner",
        pid: 999_999_999,
        hostname: hostname(),
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const saved = await store.saveBranch(state, state.revision);

    expect(saved.revision).toBe(1);
    await expect(
      readFile(path.join(lockPath, "owner.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes dead local reclaimer markers before saving", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const branch = "refs/heads/main";
    const store = new JsonReviewStore();
    const state = await store.loadBranch(repository, branch);
    const branchFile = getBranchFile(repository.storageRoot, branch);
    const markerPath = path.join(
      `${branchFile}.lock.reclaimers`,
      `${sha256(hostname())}.999999999.marker`,
    );
    await mkdir(markerPath, { recursive: true });

    const saved = await store.saveBranch(state, state.revision);

    expect(saved.revision).toBe(1);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("loads persisted state and rejects stale writes to missing branches", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const branch = "refs/heads/main";
    const store = new JsonReviewStore();
    const state = await store.loadBranch(repository, branch);
    await store.saveBranch(state, state.revision);

    expect((await store.loadBranch(repository, branch)).revision).toBe(1);
    await expect(
      store.saveBranch(
        {
          ...state,
          branch: "refs/heads/missing",
        },
        1,
      ),
    ).rejects.toBeInstanceOf(ConcurrentReviewStateError);
  });

  it("handles absent legacy state and surfaces malformed JSON", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const branch = "refs/heads/main";
    const store = new JsonReviewStore(path.join(root, "legacy"));

    expect((await store.loadBranch(repository, branch)).threads).toEqual([]);

    const branchFile = getBranchFile(repository.storageRoot, branch);
    await mkdir(path.dirname(branchFile), { recursive: true });
    await writeFile(branchFile, "{invalid json", "utf8");

    await expect(store.loadBranch(repository, branch)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("does not remove a lock owned by a live process", async () => {
    const root = await createTemporaryDirectory();
    temporaryDirectories.push(root);
    const repository = createRepository(root);
    const branch = "refs/heads/main";
    const store = new JsonReviewStore(undefined, {
      lockTimeoutMs: 25,
      lockRetryDelayMs: 5,
    });
    const state = await store.loadBranch(repository, branch);
    const branchFile = getBranchFile(repository.storageRoot, branch);
    const lockPath = `${branchFile}.lock`;
    await mkdir(lockPath, { recursive: true });
    const owner = {
      token: "live-owner",
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify(owner)}\n`,
      "utf8",
    );

    await expect(store.saveBranch(state, state.revision)).rejects.toThrow(
      "Timed out waiting for the review state lock",
    );
    expect(
      JSON.parse(
        await readFile(path.join(lockPath, "owner.json"), "utf8"),
      ) as unknown,
    ).toEqual(owner);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(process.cwd(), ".revloop-store-"));
}

function createRepository(storageRoot: string) {
  return {
    key: "repo-key",
    rootPath: "/workspace/repository",
    displayName: "repository",
    storageRoot,
  };
}

function getBranchFile(storageRoot: string, branch: string): string {
  return path.join(storageRoot, "branches", `${sha256(branch)}.json`);
}

function createLegacyState(
  repository: {
    key: string;
    rootPath: string;
    displayName: string;
  },
  branch: string,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
  };
  const anchor = {
    filePath: "src/example.ts",
    range,
    selectedText: "value",
    beforeContext: [],
    afterContext: [],
    contentHash: "hash",
    capturedAt: now,
  };
  return {
    schemaVersion: 1,
    revision: 1,
    repository,
    branch,
    threads: [
      {
        id: "thread-1",
        repositoryKey: repository.key,
        branch,
        filePath: anchor.filePath,
        languageId: "typescript",
        status: "open",
        originalAnchor: anchor,
        currentAnchor: anchor,
        anchorHistory: [{ kind: "created", at: now, toRange: range }],
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
            body: "Keep this comment.",
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
