import { lstat, readFile, readlink } from "node:fs/promises";
import { resolveRepositoryPath } from "@revloop/shared";
import type { RepositoryIdentity } from "@revloop/shared";
import { createUntrackedDiff } from "./diffParser.js";
import type { ParsedDiff } from "./types.js";

export interface UntrackedFileSnapshot {
  diff: ParsedDiff;
  canComment: boolean;
  snapshotContent?: string;
}

export interface WorkingTreeEntrySnapshot {
  canComment: boolean;
  snapshotContent?: string;
}

export async function readWorkingTreeEntry(
  repository: Pick<RepositoryIdentity, "rootPath">,
  filePath: string,
): Promise<WorkingTreeEntrySnapshot> {
  const absolutePath = resolveRepositoryPath(repository.rootPath, filePath);

  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return {
        canComment: false,
        snapshotContent: await readlink(absolutePath),
      };
    }

    return stats.isFile()
      ? { canComment: true }
      : { canComment: false, snapshotContent: "" };
  } catch {
    return {
      canComment: false,
      snapshotContent: "",
    };
  }
}

export async function readUntrackedFile(
  repository: Pick<RepositoryIdentity, "rootPath">,
  filePath: string,
): Promise<UntrackedFileSnapshot> {
  const absolutePath = resolveRepositoryPath(repository.rootPath, filePath);

  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      return {
        diff: createUntrackedDiff(filePath, target, "120000"),
        canComment: false,
        snapshotContent: target,
      };
    }

    if (!stats.isFile()) {
      return unreadableSnapshot(filePath);
    }

    const bytes = await readFile(absolutePath);
    if (bytes.includes(0)) {
      return {
        diff: createBinaryUntrackedDiff(
          filePath,
          isExecutable(stats.mode) ? "100755" : "100644",
        ),
        canComment: false,
      };
    }

    return {
      diff: createUntrackedDiff(
        filePath,
        bytes.toString("utf8"),
        isExecutable(stats.mode) ? "100755" : "100644",
      ),
      canComment: true,
    };
  } catch {
    return unreadableSnapshot(filePath);
  }
}

function unreadableSnapshot(filePath: string): UntrackedFileSnapshot {
  return {
    diff: createBinaryUntrackedDiff(filePath, "100644"),
    canComment: false,
    snapshotContent: "",
  };
}

function createBinaryUntrackedDiff(
  filePath: string,
  mode: "100644" | "100755",
): ParsedDiff {
  return {
    header: [
      `diff --git a/${filePath} b/${filePath}`,
      `new file mode ${mode}`,
      `Binary files /dev/null and b/${filePath} differ`,
    ].join("\n"),
    hunks: [],
    binary: true,
  };
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}
