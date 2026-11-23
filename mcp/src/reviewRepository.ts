import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  appendExternalAgentMessage,
  ConcurrentReviewStateError,
  createRepositoryIdentity,
  JsonReviewStore,
  normalizeRepositoryRelativePath,
} from "@revloop/shared";
import type {
  AgentReplyOutcome,
  RepositoryIdentity,
  ReviewThread,
  ReviewThreadStatus,
} from "@revloop/shared";

const execFileAsync = promisify(execFile);

export type CommentStatusFilter = ReviewThreadStatus | "unresolved" | "all";

export class McpReviewRepository {
  private readonly store = new JsonReviewStore();

  public constructor(
    private readonly repository: RepositoryIdentity,
    private readonly gitPath = "git",
  ) {}

  public static async fromWorkingDirectory(
    workingDirectory = process.cwd(),
    gitPath = configuredGitPath(),
  ): Promise<McpReviewRepository> {
    const rootOutput = await runGit(
      gitPath,
      ["rev-parse", "--show-toplevel"],
      workingDirectory,
    );
    const rootPath = await realpath(rootOutput.trim());
    const commonDirectoryOutput = await runGit(
      gitPath,
      ["rev-parse", "--git-common-dir"],
      rootPath,
    );
    const commonDirectory = await realpath(
      path.resolve(rootPath, commonDirectoryOutput.trim()),
    );
    const remoteUrl = await runOptionalGit(
      gitPath,
      ["config", "--get", "remote.origin.url"],
      rootPath,
    );

    return new McpReviewRepository(
      createRepositoryIdentity(rootPath, commonDirectory, remoteUrl.trim()),
      gitPath,
    );
  }

  public async readComments(
    status: CommentStatusFilter = "open",
    filePath?: string,
  ): Promise<{
    repository: RepositoryIdentity;
    branch: string;
    threads: readonly ReviewThread[];
  }> {
    const branch = await this.currentBranch();
    const state = await this.store.loadBranch(this.repository, branch);
    const normalizedPath =
      filePath === undefined
        ? undefined
        : normalizeRepositoryRelativePath(filePath);
    const threads = state.threads.filter(
      (thread) =>
        (status === "all" ||
          (status === "unresolved" && thread.status !== "resolved") ||
          thread.status === status) &&
        (normalizedPath === undefined || thread.filePath === normalizedPath),
    );

    return {
      repository: state.repository,
      branch,
      threads,
    };
  }

  public async replyToComment(
    threadId: string,
    body: string,
    outcome?: AgentReplyOutcome,
  ): Promise<{ branch: string; thread: ReviewThread; replyId: string }> {
    const branch = await this.currentBranch();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await this.store.loadBranch(this.repository, branch);
      const thread = state.threads.find(
        (candidate) => candidate.id === threadId,
      );
      if (thread === undefined) {
        throw new Error(`Unknown Revloop comment: ${threadId}`);
      }

      const message = appendExternalAgentMessage(thread, body, outcome);
      try {
        const saved = await this.store.saveBranch(state, state.revision);
        const savedThread = saved.threads.find(
          (candidate) => candidate.id === threadId,
        );
        if (savedThread === undefined) {
          throw new Error(
            `Revloop comment disappeared while replying: ${threadId}`,
          );
        }
        return {
          branch,
          thread: savedThread,
          replyId: message.id,
        };
      } catch (error: unknown) {
        if (!(error instanceof ConcurrentReviewStateError) || attempt === 1) {
          throw error;
        }
      }
    }

    throw new Error(`Unable to reply to Revloop comment: ${threadId}`);
  }

  private async currentBranch(): Promise<string> {
    try {
      const branchName = (
        await runGit(
          this.gitPath,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          this.repository.rootPath,
        )
      ).trim();
      if (branchName.length === 0) {
        throw new Error("Current branch is empty.");
      }
      return `refs/heads/${branchName}`;
    } catch (error: unknown) {
      throw new Error(
        `Revloop MCP requires a checked-out Git branch: ${toErrorMessage(error)}`,
      );
    }
  }
}

function configuredGitPath(): string {
  const configured = process.env.REVLOOP_GIT_PATH?.trim();
  return configured === undefined || configured.length === 0
    ? "git"
    : configured;
}

async function runGit(
  gitPath: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync(gitPath, args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}

async function runOptionalGit(
  gitPath: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    return await runGit(gitPath, args, cwd);
  } catch {
    return "";
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
