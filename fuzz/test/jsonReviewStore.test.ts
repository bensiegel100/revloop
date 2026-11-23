import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  branchStateSchemaVersion,
  ConcurrentReviewStateError,
  JsonReviewStore,
  sha256,
} from "@revloop/shared";
import type {
  BranchReviewState,
  RepositoryIdentity,
  ReviewThread,
} from "@revloop/shared";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fuzzParameters } from "../src/index.js";
import type { RepositoryTemplate } from "../src/index.js";
import {
  branchIsolationScenarioArbitrary,
  concurrentPersistenceScenarioArbitrary,
  persistenceScenarioArbitrary,
} from "./reviewStateArbitraries.js";
import type { PersistenceScenario } from "./reviewStateArbitraries.js";

describe("JSON review store fuzzing", () => {
  it("round-trips arbitrary comments through sequential saves", async () => {
    await fc.assert(
      fc.asyncProperty(persistenceScenarioArbitrary, async (scenario) => {
        await withTemporaryDirectory(async (root) => {
          const repository = createRepository(scenario.repository, root);
          const store = new JsonReviewStore();
          let current = await store.loadBranch(repository, scenario.branch);

          expect(current.revision).toBe(0);
          expect(current.threads).toEqual([]);

          for (const snapshot of scenario.snapshots) {
            const submittedThreads = cloneThreads(snapshot);
            const saved = await store.saveBranch(
              {
                ...current,
                threads: cloneThreads(submittedThreads),
              },
              current.revision,
            );
            expect(saved.revision).toBe(current.revision + 1);
            expect(saved.threads).toEqual(submittedThreads);

            const loaded = await store.loadBranch(repository, scenario.branch);
            expect(loaded).toEqual(saved);
            expect(loaded.threads).toEqual(submittedThreads);
            await expectPersistedState(repository, scenario.branch, saved);
            current = loaded;
          }

          await expectNoTemporaryArtifacts(repository);
        });
      }),
      fuzzParameters(),
    );
  });

  it("keeps generated branch states isolated", async () => {
    await fc.assert(
      fc.asyncProperty(branchIsolationScenarioArbitrary, async (scenario) => {
        await withTemporaryDirectory(async (root) => {
          const repository = createRepository(scenario.repository, root);
          const store = new JsonReviewStore();
          const savedBranches: {
            readonly branch: string;
            readonly state: BranchReviewState;
          }[] = [];

          for (const branchState of scenario.branches) {
            const initial = await store.loadBranch(
              repository,
              branchState.branch,
            );
            const saved = await store.saveBranch(
              {
                ...initial,
                threads: cloneThreads(branchState.threads),
              },
              initial.revision,
            );
            savedBranches.push({
              branch: branchState.branch,
              state: saved,
            });
          }

          for (const savedBranch of savedBranches) {
            await expectPersistedState(
              repository,
              savedBranch.branch,
              savedBranch.state,
            );
            expect(
              await store.loadBranch(repository, savedBranch.branch),
            ).toEqual(savedBranch.state);
          }
          await expectNoTemporaryArtifacts(repository);
        });
      }),
      fuzzParameters(),
    );
  });

  it("allows exactly one generated writer for each revision", async () => {
    await fc.assert(
      fc.asyncProperty(
        concurrentPersistenceScenarioArbitrary,
        async (scenario) => {
          await withTemporaryDirectory(async (root) => {
            const repository = createRepository(scenario.repository, root);
            const initial = await new JsonReviewStore().loadBranch(
              repository,
              scenario.branch,
            );
            const results = await Promise.allSettled(
              scenario.snapshots.map((snapshot) =>
                new JsonReviewStore().saveBranch(
                  {
                    ...initial,
                    threads: cloneThreads(snapshot),
                  },
                  initial.revision,
                ),
              ),
            );
            const fulfilled = results.filter(
              (result): result is PromiseFulfilledResult<BranchReviewState> =>
                result.status === "fulfilled",
            );
            const rejected = results.filter(
              (result): result is PromiseRejectedResult =>
                result.status === "rejected",
            );

            expect(fulfilled).toHaveLength(1);
            expect(rejected).toHaveLength(results.length - 1);
            for (const result of rejected) {
              expect(result.reason).toBeInstanceOf(ConcurrentReviewStateError);
            }

            const winner = fulfilled[0];
            if (winner === undefined) {
              throw new Error("Concurrent persistence had no winning writer.");
            }
            await expectPersistedState(
              repository,
              scenario.branch,
              winner.value,
            );
            expect(
              await new JsonReviewStore().loadBranch(
                repository,
                scenario.branch,
              ),
            ).toEqual(winner.value);
            await expectNoTemporaryArtifacts(repository);
          });
        },
      ),
      fuzzParameters(),
    );
  }, 15_000);

  it("migrates arbitrary legacy comments without changing their contents", async () => {
    await fc.assert(
      fc.asyncProperty(persistenceScenarioArbitrary, async (scenario) => {
        await withTemporaryDirectory(async (root) => {
          const repository = createRepository(scenario.repository, root);
          const snapshot = requireFirstSnapshot(scenario);
          const legacyRoot = path.join(root, "legacy");
          const legacyFile = path.join(
            legacyRoot,
            "repositories",
            repository.key,
            "branches",
            `${sha256(scenario.branch)}.json`,
          );
          const legacyState = {
            schemaVersion: branchStateSchemaVersion,
            revision: scenario.legacyState.revision,
            repository: scenario.repository,
            branch: scenario.branch,
            threads: cloneThreads(snapshot),
            createdAt: scenario.legacyState.createdAt,
            updatedAt: scenario.legacyState.updatedAt,
          };
          await mkdir(path.dirname(legacyFile), { recursive: true });
          await writeFile(
            legacyFile,
            `${JSON.stringify(legacyState, null, 2)}\n`,
            "utf8",
          );

          const migrated = await new JsonReviewStore(legacyRoot).loadBranch(
            repository,
            scenario.branch,
          );

          expect(migrated).toEqual({
            ...legacyState,
            repository,
          });
          await expectPersistedState(repository, scenario.branch, migrated);
          await expectNoTemporaryArtifacts(repository);
        });
      }),
      fuzzParameters(),
    );
  });
});

async function withTemporaryDirectory(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "revloop-store-fuzz-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createRepository(
  template: RepositoryTemplate,
  root: string,
): RepositoryIdentity {
  return {
    ...template,
    storageRoot: path.join(root, "git", "revloop"),
  };
}

function cloneThreads(threads: readonly ReviewThread[]): ReviewThread[] {
  return structuredClone([...threads]);
}

function requireFirstSnapshot(
  scenario: PersistenceScenario,
): readonly ReviewThread[] {
  const snapshot = scenario.snapshots[0];
  if (snapshot === undefined) {
    throw new Error("Persistence scenario requires at least one snapshot.");
  }
  return snapshot;
}

async function expectPersistedState(
  repository: RepositoryIdentity,
  branch: string,
  expected: BranchReviewState,
): Promise<void> {
  const filePath = getBranchFile(repository, branch);
  expect(JSON.parse(await readFile(filePath, "utf8")) as unknown).toEqual(
    expected,
  );
}

async function expectNoTemporaryArtifacts(
  repository: RepositoryIdentity,
): Promise<void> {
  const branchesDirectory = path.join(repository.storageRoot, "branches");
  const entries = await readdir(branchesDirectory);
  const unexpected: string[] = [];

  for (const entry of entries) {
    if (entry.endsWith(".json")) {
      continue;
    }
    if (entry.endsWith(".lock.reclaimers")) {
      expect(await readdir(path.join(branchesDirectory, entry))).toEqual([]);
      continue;
    }
    unexpected.push(entry);
  }

  expect(unexpected).toEqual([]);
}

function getBranchFile(repository: RepositoryIdentity, branch: string): string {
  return path.join(
    repository.storageRoot,
    "branches",
    `${sha256(branch)}.json`,
  );
}
