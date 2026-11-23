import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as fc from "fast-check";
import { safePathSegmentArbitrary } from "./arbitraries.js";
import type { GitRepositoryFixture } from "./gitRepository.js";

export type GitWorkspaceChangeKind =
  "modified" | "deleted" | "renamed" | "added" | "untracked";

export interface GitWorkspaceChange {
  readonly key: string;
  readonly kind: GitWorkspaceChangeKind;
  readonly payload: string;
}

export interface GitRepositoryRecipe {
  readonly changes: readonly GitWorkspaceChange[];
}

export interface ExpectedGitChange {
  readonly path: string;
  readonly status: "modified" | "deleted" | "renamed" | "added";
  readonly originalPath?: string;
}

export interface AppliedGitRepositoryRecipe {
  readonly baseRef: string;
  readonly trackedChanges: readonly ExpectedGitChange[];
  readonly untrackedPaths: readonly string[];
  readonly commentablePaths: readonly string[];
}

const payloadArbitrary = fc
  .array(fc.string({ maxLength: 40 }), { maxLength: 4 })
  .map((lines) => lines.join("\n"));
const changeArbitrary: fc.Arbitrary<GitWorkspaceChange> = fc.record({
  key: safePathSegmentArbitrary,
  kind: fc.constantFrom<GitWorkspaceChangeKind>(
    "modified",
    "deleted",
    "renamed",
    "added",
    "untracked",
  ),
  payload: payloadArbitrary,
});

export const gitRepositoryRecipeArbitrary: fc.Arbitrary<GitRepositoryRecipe> =
  fc
    .uniqueArray(changeArbitrary, {
      minLength: 1,
      maxLength: 8,
      selector: (change) => change.key,
    })
    .map((changes) => ({ changes }));

export const commentableGitRepositoryRecipeArbitrary: fc.Arbitrary<GitRepositoryRecipe> =
  gitRepositoryRecipeArbitrary.filter((recipe) =>
    recipe.changes.some((change) => change.kind !== "deleted"),
  );

export async function applyGitRepositoryRecipe(
  fixture: GitRepositoryFixture,
  recipe: GitRepositoryRecipe,
): Promise<AppliedGitRepositoryRecipe> {
  await fixture.reset();

  for (const change of recipe.changes) {
    if (
      change.kind === "modified" ||
      change.kind === "deleted" ||
      change.kind === "renamed"
    ) {
      await writeTextFile(
        fixture.rootPath,
        sourcePath(change),
        baseContent(change),
      );
    }
  }
  await fixture.git(["add", "."]);
  await fixture.git(
    [
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Create generated fuzz base",
    ],
    "2026-01-01T00:01:00Z",
  );
  const baseRef = (await fixture.git(["rev-parse", "HEAD"])).trim();

  const trackedChanges: ExpectedGitChange[] = [];
  const untrackedPaths: string[] = [];
  const commentablePaths: string[] = [];

  for (const change of recipe.changes) {
    const source = sourcePath(change);
    switch (change.kind) {
      case "modified": {
        await writeTextFile(fixture.rootPath, source, stagedContent(change));
        await fixture.git(["add", "--", source]);
        await writeTextFile(fixture.rootPath, source, workspaceContent(change));
        trackedChanges.push({ path: source, status: "modified" });
        commentablePaths.push(source);
        break;
      }
      case "deleted": {
        await rm(path.join(fixture.rootPath, source));
        trackedChanges.push({ path: source, status: "deleted" });
        break;
      }
      case "renamed": {
        const destination = renamedPath(change);
        await fixture.git(["mv", "--", source, destination]);
        await writeTextFile(
          fixture.rootPath,
          destination,
          `${baseContent(change)}renamed ${change.key}\n`,
        );
        trackedChanges.push({
          path: destination,
          originalPath: source,
          status: "renamed",
        });
        commentablePaths.push(destination);
        break;
      }
      case "added": {
        await writeTextFile(fixture.rootPath, source, stagedContent(change));
        await fixture.git(["add", "--", source]);
        await writeTextFile(fixture.rootPath, source, workspaceContent(change));
        trackedChanges.push({ path: source, status: "added" });
        commentablePaths.push(source);
        break;
      }
      case "untracked": {
        await writeTextFile(fixture.rootPath, source, workspaceContent(change));
        untrackedPaths.push(source);
        commentablePaths.push(source);
        break;
      }
    }
  }

  return {
    baseRef,
    trackedChanges: sortedByPath(trackedChanges),
    untrackedPaths: sortedPaths(untrackedPaths),
    commentablePaths: sortedPaths(commentablePaths),
  };
}

function sourcePath(change: GitWorkspaceChange): string {
  return `generated/${encodedKey(change.key)}/file.txt`;
}

function renamedPath(change: GitWorkspaceChange): string {
  return `generated/${encodedKey(change.key)}/renamed.txt`;
}

function baseContent(change: GitWorkspaceChange): string {
  const lines = Array.from(
    { length: 32 },
    (_, index) =>
      `base ${change.kind} ${encodedKey(change.key)} ${String(index)}`,
  );
  return `${lines.join("\n")}\n${change.payload}\n`;
}

function stagedContent(change: GitWorkspaceChange): string {
  return `${baseContent(change)}staged ${change.key}\n`;
}

function workspaceContent(change: GitWorkspaceChange): string {
  return `${stagedContent(change)}workspace ${change.key}\n`;
}

function encodedKey(key: string): string {
  return Buffer.from(key, "utf8").toString("hex");
}

async function writeTextFile(
  rootPath: string,
  filePath: string,
  content: string,
): Promise<void> {
  const absolutePath = path.join(rootPath, ...filePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function sortedByPath(
  changes: readonly ExpectedGitChange[],
): ExpectedGitChange[] {
  return [...changes].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function sortedPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}
