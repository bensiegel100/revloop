import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeRepositoryRelativePath,
  resolveRepositoryPath,
} from "../../src/platform/paths.js";

describe("repository paths", () => {
  it("normalizes Windows separators", () => {
    expect(normalizeRepositoryRelativePath("src\\feature\\index.ts")).toBe(
      "src/feature/index.ts",
    );
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => normalizeRepositoryRelativePath("../secret")).toThrow();
    expect(() => normalizeRepositoryRelativePath("/tmp/secret")).toThrow();
    expect(() => normalizeRepositoryRelativePath("C:\\secret")).toThrow();
  });

  it("resolves paths within the repository root", () => {
    const repositoryRoot = path.join(
      path.parse(process.cwd()).root,
      "workspace",
      "project",
    );

    expect(resolveRepositoryPath(repositoryRoot, "src/index.ts")).toBe(
      path.join(repositoryRoot, "src", "index.ts"),
    );
  });
});
