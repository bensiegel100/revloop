import { normalizeRepositoryRelativePath } from "@revloop/shared";
import type { ReviewFileStatus } from "./types.js";

export interface GitDiffEntry {
  path: string;
  originalPath?: string;
  status: ReviewFileStatus;
}

export function parseNullSeparatedPaths(output: string): string[] {
  return output
    .split("\0")
    .filter((value) => value.length > 0)
    .map(normalizeRepositoryRelativePath);
}

export function parseGitDiffEntries(output: string): GitDiffEntry[] {
  const segments = output.split("\0");
  if (segments.at(-1) === "") {
    segments.pop();
  }

  const changes: GitDiffEntry[] = [];
  let index = 0;
  while (index < segments.length) {
    const statusToken = segments[index];
    if (statusToken === undefined || statusToken.length === 0) {
      throw new Error("Malformed Git diff status output.");
    }
    index += 1;

    const statusCode = statusToken[0];
    if (statusCode === "R") {
      const originalPath = segments[index];
      const filePath = segments[index + 1];
      if (originalPath === undefined || filePath === undefined) {
        throw new Error(`Malformed Git rename status: ${statusToken}`);
      }
      index += 2;
      changes.push({
        path: normalizeRepositoryRelativePath(filePath),
        originalPath: normalizeRepositoryRelativePath(originalPath),
        status: "renamed",
      });
      continue;
    }

    const filePath = segments[index];
    if (filePath === undefined) {
      throw new Error(`Malformed Git diff status: ${statusToken}`);
    }
    index += 1;
    changes.push({
      path: normalizeRepositoryRelativePath(filePath),
      status: mapDiffStatus(statusCode, statusToken),
    });
  }

  return changes;
}

function mapDiffStatus(
  statusCode: string | undefined,
  statusToken: string,
): ReviewFileStatus {
  if (statusCode === undefined) {
    throw new Error(`Unsupported Git diff status: ${statusToken}`);
  }

  switch (statusCode) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "T":
      return "type-changed";
    default:
      throw new Error(`Unsupported Git diff status: ${statusToken}`);
  }
}
