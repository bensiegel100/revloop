import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createRepositoryIdentity } from "@revloop/shared";
import type { RepositoryIdentity } from "@revloop/shared";
import { parseGitDiffEntries, parseNullSeparatedPaths } from "./gitOutput.js";
import type { GitDiffEntry } from "./gitOutput.js";

export async function discoverRepositoryIdentity(
  executable: string,
  rootPath: string,
): Promise<RepositoryIdentity> {
  const canonicalRoot = await realpath(rootPath);
  const commonDirectoryOutput = await runGit(
    executable,
    ["rev-parse", "--git-common-dir"],
    canonicalRoot,
  );
  const commonDirectory = await realpath(
    path.resolve(canonicalRoot, commonDirectoryOutput.trim()),
  );

  let remoteUrl = "";
  try {
    remoteUrl = (
      await runGit(
        executable,
        ["config", "--get", "remote.origin.url"],
        canonicalRoot,
      )
    ).trim();
  } catch {
    // Repositories without an origin still have a stable local identity.
  }

  return createRepositoryIdentity(canonicalRoot, commonDirectory, remoteUrl);
}

export async function listTrackedChanges(
  executable: string,
  cwd: string,
  baseRef: string,
): Promise<GitDiffEntry[]> {
  const output = await runGit(
    executable,
    [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--diff-filter=ADMRT",
      baseRef,
      "--",
    ],
    cwd,
  );
  return parseGitDiffEntries(output);
}

export function readTrackedPatch(
  executable: string,
  cwd: string,
  baseRef: string,
  change: GitDiffEntry,
): Promise<string> {
  const paths =
    change.originalPath === undefined
      ? [change.path]
      : [change.originalPath, change.path];
  return runGit(
    executable,
    [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--binary",
      "--find-renames",
      baseRef,
      "--",
      ...paths,
    ],
    cwd,
  );
}

export async function listUntrackedFilePaths(
  executable: string,
  cwd: string,
): Promise<string[]> {
  const output = await runGit(
    executable,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
  );
  return parseNullSeparatedPaths(output);
}

export function runGit(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }

      reject(
        new Error(
          `Git exited with code ${String(code)}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
}
