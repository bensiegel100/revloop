import { describe, expect, it } from "vitest";
import {
  parseGitDiffEntries,
  parseNullSeparatedPaths,
} from "../../src/git/gitOutput.js";

describe("Git path output", () => {
  it("parses every NUL-separated untracked file", () => {
    expect(
      parseNullSeparatedPaths(
        "src/index.ts\0src/feature file.ts\0test/index.test.ts\0",
      ),
    ).toEqual(["src/index.ts", "src/feature file.ts", "test/index.test.ts"]);
  });

  it("parses tracked statuses and both sides of renames", () => {
    expect(
      parseGitDiffEntries(
        [
          "M",
          "src/modified.ts",
          "A",
          "src/added.ts",
          "D",
          "src/deleted.ts",
          "T",
          "src/type.ts",
          "R087",
          "src/old name.ts",
          "src/new name.ts",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      { path: "src/modified.ts", status: "modified" },
      { path: "src/added.ts", status: "added" },
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/type.ts", status: "type-changed" },
      {
        path: "src/new name.ts",
        originalPath: "src/old name.ts",
        status: "renamed",
      },
    ]);
  });

  it("rejects malformed and unsupported status output", () => {
    expect(() => parseGitDiffEntries("\0")).toThrow(
      "Malformed Git diff status output.",
    );
    expect(() => parseGitDiffEntries("R100\0src/old.ts\0")).toThrow(
      "Malformed Git rename status: R100",
    );
    expect(() => parseGitDiffEntries("M\0")).toThrow(
      "Malformed Git diff status: M",
    );
    expect(() => parseGitDiffEntries("X\0src/index.ts\0")).toThrow(
      "Unsupported Git diff status: X",
    );
  });
});
