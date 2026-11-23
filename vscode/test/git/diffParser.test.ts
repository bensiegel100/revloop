import { describe, expect, it } from "vitest";
import {
  createUntrackedDiff,
  findHunkForLines,
  parseUnifiedDiff,
  toContiguousLineRanges,
} from "../../src/git/diffParser.js";

describe("unified diff parser", () => {
  it("indexes modified-side added lines", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/example.ts b/example.ts",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -1,3 +1,4 @@",
        " keep",
        "-old",
        "+new",
        "+extra",
        " end",
      ].join("\n"),
    );

    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]?.modifiedLines).toEqual([1, 2]);
    expect(findHunkForLines(parsed, 2, 2)?.newLines).toBe(4);
  });

  it("creates a synthetic all-added diff for an untracked file", () => {
    const parsed = createUntrackedDiff("new.ts", "one\ntwo\n");
    expect(parsed.hunks[0]?.modifiedLines).toEqual([0, 1]);
  });

  it("keeps added source lines beginning with two plus signs", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/example.ts b/example.ts",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -0,0 +1 @@",
        "+++counter;",
      ].join("\n"),
    );

    expect(parsed.hunks[0]?.modifiedLines).toEqual([0]);
    expect(parsed.hunks[0]?.hunk).toContain("+++counter;");
  });

  it("coalesces modified lines into commentable ranges", () => {
    expect(toContiguousLineRanges([5, 2, 3, 5, 8])).toEqual([
      [2, 3],
      [5, 5],
      [8, 8],
    ]);
  });
});
