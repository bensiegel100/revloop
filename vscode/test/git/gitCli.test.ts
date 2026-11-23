import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/git/diffParser.js";
import {
  discoverRepositoryIdentity,
  listTrackedChanges,
  listUntrackedFilePaths,
  readTrackedPatch,
  runGit,
} from "../../src/git/gitCli.js";

describe("Git review snapshots", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  it("compares HEAD to the complete workspace state", async () => {
    const repository = await createRepository();
    const head = (await git(repository, ["rev-parse", "HEAD"])).trim();

    await writeFile(
      path.join(repository, "mixed.txt"),
      "base\nstaged\n",
      "utf8",
    );
    await git(repository, ["add", "mixed.txt"]);
    await writeFile(
      path.join(repository, "mixed.txt"),
      "base\nstaged\nunstaged\n",
      "utf8",
    );

    await writeFile(path.join(repository, "added.txt"), "staged\n", "utf8");
    await git(repository, ["add", "added.txt"]);
    await writeFile(
      path.join(repository, "added.txt"),
      "staged\nunstaged\n",
      "utf8",
    );

    await git(repository, ["rm", "-q", "deleted.txt"]);
    await git(repository, ["mv", "old-name.txt", "new-name.txt"]);
    await writeFile(
      path.join(repository, "new-name.txt"),
      `${numberedLines(8)}++counter;\n`,
      "utf8",
    );
    await writeFile(
      path.join(repository, "untracked.txt"),
      "untracked\n",
      "utf8",
    );

    const changes = await listTrackedChanges("git", repository, head);
    expect(
      changes.map(({ path: filePath, status }) => [filePath, status]),
    ).toEqual([
      ["added.txt", "added"],
      ["deleted.txt", "deleted"],
      ["mixed.txt", "modified"],
      ["new-name.txt", "renamed"],
    ]);
    expect(await listUntrackedFilePaths("git", repository)).toEqual([
      "untracked.txt",
    ]);

    const mixed = changes.find((change) => change.path === "mixed.txt");
    if (mixed === undefined) {
      throw new Error("Expected mixed.txt in the HEAD-to-workspace diff.");
    }
    const mixedPatch = await readTrackedPatch("git", repository, head, mixed);
    expect(mixedPatch).toContain("+staged");
    expect(mixedPatch).toContain("+unstaged");

    const renamed = changes.find((change) => change.status === "renamed");
    expect(renamed).toEqual({
      path: "new-name.txt",
      originalPath: "old-name.txt",
      status: "renamed",
    });
    if (renamed === undefined) {
      throw new Error("Expected the renamed file in the workspace diff.");
    }
    const renamePatch = await readTrackedPatch(
      "git",
      repository,
      head,
      renamed,
    );
    expect(renamePatch).toContain("diff --git a/old-name.txt b/new-name.txt");
    expect(renamePatch).toContain("rename from old-name.txt");
    expect(renamePatch).toContain("rename to new-name.txt");
    expect(parseUnifiedDiff(renamePatch).hunks[0]?.modifiedLines).toEqual([8]);
  });

  it("keeps branch reviews based at the merge base and ending at the workspace", async () => {
    const repository = await createRepository();
    const mergeBase = (await git(repository, ["rev-parse", "HEAD"])).trim();

    await writeFile(
      path.join(repository, "mixed.txt"),
      "base\ncommitted\n",
      "utf8",
    );
    await git(repository, ["mv", "old-name.txt", "branch-name.txt"]);
    await git(repository, ["add", "mixed.txt"]);
    await git(repository, ["commit", "-qm", "branch change"]);
    await writeFile(
      path.join(repository, "mixed.txt"),
      "base\ncommitted\nworkspace\n",
      "utf8",
    );
    await writeFile(
      path.join(repository, "branch-name.txt"),
      `${numberedLines(8)}branch workspace\n`,
      "utf8",
    );

    const changes = await listTrackedChanges("git", repository, mergeBase);
    const mixed = changes.find((change) => change.path === "mixed.txt");
    if (mixed === undefined) {
      throw new Error("Expected the branch diff to contain mixed.txt.");
    }
    const patch = await readTrackedPatch("git", repository, mergeBase, mixed);
    expect(patch).toContain("+committed");
    expect(patch).toContain("+workspace");

    const renamed = changes.find((change) => change.status === "renamed");
    if (renamed === undefined) {
      throw new Error("Expected the branch diff to preserve its rename.");
    }
    const renamePatch = await readTrackedPatch(
      "git",
      repository,
      mergeBase,
      renamed,
    );
    expect(renamePatch).toContain(
      "diff --git a/old-name.txt b/branch-name.txt",
    );
    expect(renamePatch).toContain("rename from old-name.txt");
    expect(renamePatch).toContain("rename to branch-name.txt");
  });

  it("uses one repository identity through a symlink-opened workspace", async () => {
    const repository = await createRepository();
    const linkedRoot = `${repository}-link`;
    cleanupPaths.push(linkedRoot);
    await symlink(
      repository,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    const [realIdentity, linkedIdentity] = await Promise.all([
      discoverRepositoryIdentity("git", repository),
      discoverRepositoryIdentity("git", linkedRoot),
    ]);

    expect(linkedIdentity).toEqual(realIdentity);

    await writeFile(
      path.join(linkedRoot, "mixed.txt"),
      "changed through symlink\n",
      "utf8",
    );
    const head = (await git(repository, ["rev-parse", "HEAD"])).trim();
    expect(
      await listTrackedChanges("git", linkedIdentity.rootPath, head),
    ).toEqual([{ path: "mixed.txt", status: "modified" }]);
  });

  async function createRepository(): Promise<string> {
    const repository = await mkdtemp(
      path.join(process.cwd(), "test/.git-review-"),
    );
    cleanupPaths.push(repository);
    await git(repository, ["init", "-q"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repository, "mixed.txt"), "base\n", "utf8");
    await writeFile(path.join(repository, "deleted.txt"), "delete\n", "utf8");
    await writeFile(
      path.join(repository, "old-name.txt"),
      numberedLines(8),
      "utf8",
    );
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-qm", "initial"]);
    return repository;
  }
});

function git(repository: string, args: readonly string[]): Promise<string> {
  return runGit("git", args, repository);
}

function numberedLines(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `line ${String(index)}\n`,
  ).join("");
}
