import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepositoryIdentity } from "../../src/platform/repositoryIdentity.js";

describe("repository identity", () => {
  it("normalizes equivalent repository and common-directory paths", () => {
    const root = path.resolve("workspace/repository");
    const commonDirectory = path.join(root, ".git");

    expect(
      createRepositoryIdentity(
        path.join(root, "."),
        path.join(root, "nested", "..", ".git"),
        " origin\n",
      ),
    ).toEqual(createRepositoryIdentity(root, commonDirectory, "origin"));
  });
});
