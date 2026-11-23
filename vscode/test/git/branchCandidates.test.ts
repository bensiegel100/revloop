import { describe, expect, it } from "vitest";
import { collectBaseBranchCandidates } from "../../src/git/branchCandidates.js";

describe("base branch candidates", () => {
  it("finds another local branch in a linked worktree", () => {
    expect(
      collectBaseBranchCandidates("implement-prd", [
        { name: "implement-prd" },
        { name: "main" },
      ]),
    ).toEqual(["main"]);
  });

  it("merges cached and queried refs without duplicates", () => {
    expect(
      collectBaseBranchCandidates(
        "feature",
        [{ name: "main" }, { name: "origin/main" }],
        [{ name: "main" }, { name: "origin/HEAD" }],
      ),
    ).toEqual(["main", "origin/main"]);
  });
});
