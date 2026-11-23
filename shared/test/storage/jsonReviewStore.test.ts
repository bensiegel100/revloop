import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../src/platform/hash.js";
import {
  ConcurrentReviewStateError,
  JsonReviewStore,
} from "../../src/storage/jsonReviewStore.js";

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
