import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readUntrackedFile,
  readWorkingTreeEntry,
} from "../../src/git/untrackedFile.js";

describe("untracked file snapshots", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  it("captures a symlink target without reading the external file", async () => {
    const parent = await mkdtemp(
      path.join(process.cwd(), "test/.untracked-link-"),
    );
    cleanupPaths.push(parent);
    const repository = path.join(parent, "repository");
    const external = path.join(parent, "external.txt");
    await mkdir(repository);
    await writeFile(external, "external secret\n", "utf8");
    await symlink("../external.txt", path.join(repository, "link.txt"));

    const snapshot = await readUntrackedFile(
      { rootPath: repository },
      "link.txt",
    );

    expect(snapshot.snapshotContent).toBe("../external.txt");
    expect(snapshot.diff.header).toContain("new file mode 120000");
    expect(snapshot.diff.hunks[0]?.hunk).toContain("+../external.txt");
    expect(snapshot.diff.hunks[0]?.hunk).not.toContain("external secret");
    expect(snapshot.canComment).toBe(false);
  });

  it("uses a safe snapshot for a tracked symlink display", async () => {
    const parent = await mkdtemp(
      path.join(process.cwd(), "test/.tracked-link-"),
    );
    cleanupPaths.push(parent);
    const repository = path.join(parent, "repository");
    const external = path.join(parent, "external.txt");
    await mkdir(repository);
    await writeFile(external, "external secret\n", "utf8");
    await symlink("../external.txt", path.join(repository, "link.txt"));

    const snapshot = await readWorkingTreeEntry(
      { rootPath: repository },
      "link.txt",
    );

    expect(snapshot).toEqual({
      canComment: false,
      snapshotContent: "../external.txt",
    });
  });

  it("returns a non-commentable placeholder when an untracked path disappears", async () => {
    const repository = await mkdtemp(
      path.join(process.cwd(), "test/.untracked-missing-"),
    );
    cleanupPaths.push(repository);

    const snapshot = await readUntrackedFile(
      { rootPath: repository },
      "missing.txt",
    );

    expect(snapshot.diff.binary).toBe(true);
    expect(snapshot.snapshotContent).toBe("");
    expect(snapshot.canComment).toBe(false);
  });

  it("classifies regular, directory, and missing working-tree entries", async () => {
    const repository = await mkdtemp(
      path.join(process.cwd(), "test/.working-tree-entry-"),
    );
    cleanupPaths.push(repository);
    await writeFile(path.join(repository, "file.txt"), "text\n");
    await mkdir(path.join(repository, "directory"));

    await expect(
      readWorkingTreeEntry({ rootPath: repository }, "file.txt"),
    ).resolves.toEqual({ canComment: true });
    await expect(
      readWorkingTreeEntry({ rootPath: repository }, "directory"),
    ).resolves.toEqual({
      canComment: false,
      snapshotContent: "",
    });
    await expect(
      readWorkingTreeEntry({ rootPath: repository }, "missing.txt"),
    ).resolves.toEqual({
      canComment: false,
      snapshotContent: "",
    });
  });

  it("detects binary and executable untracked files", async () => {
    const repository = await mkdtemp(
      path.join(process.cwd(), "test/.untracked-binary-"),
    );
    cleanupPaths.push(repository);
    const binaryPath = path.join(repository, "binary.dat");
    const executablePath = path.join(repository, "script.sh");
    await writeFile(binaryPath, Buffer.from([1, 0, 2]));
    await writeFile(executablePath, "#!/bin/sh\necho test\n", {
      mode: 0o755,
    });

    const binary = await readUntrackedFile(
      { rootPath: repository },
      "binary.dat",
    );
    const executable = await readUntrackedFile(
      { rootPath: repository },
      "script.sh",
    );

    expect(binary.diff.binary).toBe(true);
    expect(binary.canComment).toBe(false);
    expect(executable.diff.header).toContain(
      process.platform === "win32"
        ? "new file mode 100644"
        : "new file mode 100755",
    );
    expect(executable.canComment).toBe(true);
  });

  it("treats untracked directories as unreadable snapshots", async () => {
    const repository = await mkdtemp(
      path.join(process.cwd(), "test/.untracked-directory-"),
    );
    cleanupPaths.push(repository);
    await mkdir(path.join(repository, "directory"));

    const snapshot = await readUntrackedFile(
      { rootPath: repository },
      "directory",
    );

    expect(snapshot.diff.binary).toBe(true);
    expect(snapshot.snapshotContent).toBe("");
  });
});
