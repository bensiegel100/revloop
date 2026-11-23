import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRepositoryIdentity } from "@revloop/shared";
import type { RepositoryIdentity } from "@revloop/shared";

const execFileAsync = promisify(execFile);
const branchName = "fuzz-integration";
const branchRef = `refs/heads/${branchName}`;
const gitEnvironmentVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
] as const;
const gitEnvironmentVariableSet: ReadonlySet<string> = new Set(
  gitEnvironmentVariables,
);

export interface GitRepositoryFixture {
  readonly rootPath: string;
  readonly nestedPath: string;
  readonly branchName: string;
  readonly branchRef: string;
  readonly initialCommit: string;
  readonly repository: RepositoryIdentity;
  git(args: readonly string[], timestamp?: string): Promise<string>;
  reset(): Promise<void>;
  resetReviewState(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createGitRepositoryFixture(): Promise<GitRepositoryFixture> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "revloop-git-fuzz-"));
  try {
    await runGit(rootPath, ["init", `--initial-branch=${branchName}`]);
    await runGit(rootPath, ["config", "user.name", "Revloop Fuzz"]);
    await runGit(rootPath, [
      "config",
      "user.email",
      "revloop-fuzz@example.test",
    ]);

    const nestedPath = path.join(rootPath, "src");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(path.join(rootPath, "README.md"), "# Fuzz fixture\n");
    await writeFile(
      path.join(nestedPath, "example.ts"),
      "export const value = 1;\n",
    );
    await runGit(rootPath, ["add", "."]);
    await runGit(
      rootPath,
      [
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-m",
        "Create deterministic fuzz fixture",
      ],
      "2026-01-01T00:00:00Z",
    );
    const initialCommit = (
      await runGit(rootPath, ["rev-parse", "HEAD"])
    ).trim();

    const canonicalRoot = await realpath(rootPath);
    const commonDirectoryOutput = await runGit(canonicalRoot, [
      "rev-parse",
      "--git-common-dir",
    ]);
    const commonDirectory = await realpath(
      path.resolve(canonicalRoot, commonDirectoryOutput.trim()),
    );
    const repository = createRepositoryIdentity(canonicalRoot, commonDirectory);

    return {
      rootPath: canonicalRoot,
      nestedPath: path.join(canonicalRoot, "src"),
      branchName,
      branchRef,
      initialCommit,
      repository,
      git: (args, timestamp) => runGit(canonicalRoot, args, timestamp),
      reset: async () => {
        await runGit(canonicalRoot, ["reset", "--hard", initialCommit]);
        await runGit(canonicalRoot, ["clean", "-fdx"]);
        await rm(repository.storageRoot, { recursive: true, force: true });
      },
      resetReviewState: () =>
        rm(repository.storageRoot, { recursive: true, force: true }),
      dispose: () => rm(canonicalRoot, { recursive: true, force: true }),
    };
  } catch (error: unknown) {
    await rm(rootPath, { recursive: true, force: true });
    throw error;
  }
}

async function runGit(
  rootPath: string,
  args: readonly string[],
  timestamp?: string,
): Promise<string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !gitEnvironmentVariableSet.has(name),
    ),
  );
  if (timestamp !== undefined) {
    environment.GIT_AUTHOR_DATE = timestamp;
    environment.GIT_COMMITTER_DATE = timestamp;
  }

  const { stdout } = await execFileAsync("git", args, {
    cwd: rootPath,
    encoding: "utf8",
    env: environment,
  });
  return stdout;
}
