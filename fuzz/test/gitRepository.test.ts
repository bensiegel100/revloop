import {
  applyGitRepositoryRecipe,
  createGitRepositoryFixture,
  fuzzParameters,
  gitRepositoryRecipeArbitrary,
} from "../src/index.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../vscode/src/git/diffParser.js";
import {
  discoverRepositoryIdentity,
  listTrackedChanges,
  listUntrackedFilePaths,
  readTrackedPatch,
} from "../../vscode/src/git/gitCli.js";

describe("generated Git repositories", () => {
  it("reports generated tracked, renamed, deleted, added, and untracked files", async () => {
    expect.hasAssertions();
    const fixture = await createGitRepositoryFixture();
    try {
      await fc.assert(
        fc.asyncProperty(gitRepositoryRecipeArbitrary, async (recipe) => {
          await expectRecipe(fixture, recipe);
        }),
        fuzzParameters(),
      );
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it("keeps normalized paths distinct and independent changes unpaired", async () => {
    expect.hasAssertions();
    const fixture = await createGitRepositoryFixture();
    try {
      await fixture.git(["config", "commit.gpgSign", "true"]);
      const sharedPayload = "shared rename-like payload\n".repeat(20);

      await expectRecipe(fixture, {
        changes: [
          { key: "A", kind: "modified", payload: "" },
          { key: "a", kind: "modified", payload: "" },
          { key: "name", kind: "deleted", payload: sharedPayload },
          { key: "name.", kind: "added", payload: sharedPayload },
        ],
      });
    } finally {
      await fixture.dispose();
    }
  });
});

async function expectRecipe(
  fixture: Awaited<ReturnType<typeof createGitRepositoryFixture>>,
  recipe: Parameters<typeof applyGitRepositoryRecipe>[1],
): Promise<void> {
  const applied = await applyGitRepositoryRecipe(fixture, recipe);
  const tracked = await listTrackedChanges(
    "git",
    fixture.rootPath,
    applied.baseRef,
  );
  const untracked = await listUntrackedFilePaths("git", fixture.rootPath);

  expect(
    tracked
      .map((change) => ({
        path: change.path,
        status: change.status,
        ...(change.originalPath === undefined
          ? {}
          : { originalPath: change.originalPath }),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  ).toEqual(applied.trackedChanges);
  expect(
    [...untracked].sort((left, right) => left.localeCompare(right)),
  ).toEqual(applied.untrackedPaths);

  for (const change of tracked) {
    const patch = await readTrackedPatch(
      "git",
      fixture.rootPath,
      applied.baseRef,
      change,
    );
    const parsed = parseUnifiedDiff(patch);
    expect(patch).toContain("diff --git");
    expect(parsed.binary).toBe(false);
    expect(
      change.status === "deleted" ||
        parsed.hunks.some((hunk) => hunk.modifiedLines.length > 0),
    ).toBe(true);
  }

  expect(await discoverRepositoryIdentity("git", fixture.rootPath)).toEqual(
    fixture.repository,
  );
}
