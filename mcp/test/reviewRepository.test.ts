import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReviewThread,
  JsonReviewStore,
  resolveThread,
  sha256,
} from "@revloop/shared";
import type {
  AnchorSnapshot,
  NewThreadInput,
  RepositoryIdentity,
} from "@revloop/shared";
import { McpReviewRepository } from "../src/reviewRepository.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("MCP review repository", () => {
  it("defaults to open comments and appends replies without resolving", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "revloop-mcp-"));
    temporaryDirectories.push(repositoryRoot);
    const branchName = "review-test";
    await initializeRepository(repositoryRoot, branchName);
    const repository = createRepositoryIdentity(repositoryRoot);
    const gitPath = "git";
    const branch = `refs/heads/${branchName}`;
    const store = new JsonReviewStore();
    const state = await store.loadBranch(repository, branch);
    const openThread = createThread(
      branch,
      "open-thread",
      "Please change this.",
    );
    const resolvedThread = createThread(
      branch,
      "resolved-thread",
      "Already handled.",
    );
    const outdatedThread = createThread(
      branch,
      "outdated-thread",
      "The anchor moved.",
    );
    outdatedThread.status = "outdated";
    resolveThread(resolvedThread);
    state.threads.push(openThread, resolvedThread, outdatedThread);
    await store.saveBranch(state, state.revision);

    const mcpRepository = new McpReviewRepository(repository, gitPath);

    const open = await mcpRepository.readComments();
    expect(open.threads.map((thread) => thread.id)).toEqual(["open-thread"]);

    const reply = await mcpRepository.replyToComment(
      openThread.id,
      "Updated the implementation and added coverage.",
      "changed",
    );
    expect(reply.thread.status).toBe("open");
    expect(reply.thread.messages.at(-1)).toMatchObject({
      author: "agent",
      outcome: "changed",
      body: "Updated the implementation and added coverage.",
    });

    const resolved = await mcpRepository.readComments("resolved");
    expect(resolved.threads.map((thread) => thread.id)).toEqual([
      "resolved-thread",
    ]);

    const unresolved = await mcpRepository.readComments("unresolved");
    expect(unresolved.threads.map((thread) => thread.id)).toEqual([
      "open-thread",
      "outdated-thread",
    ]);

    const allForFile = await mcpRepository.readComments(
      "all",
      "src\\example.ts",
    );
    expect(allForFile.threads.map((thread) => thread.id)).toEqual([
      "open-thread",
      "resolved-thread",
      "outdated-thread",
    ]);

    await expect(
      mcpRepository.replyToComment("missing-thread", "No matching thread."),
    ).rejects.toThrow("Unknown Revloop comment: missing-thread");
  });

  it("discovers repository identity from a working directory", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "revloop-mcp-"));
    temporaryDirectories.push(repositoryRoot);
    const branchName = "review-test";
    await initializeRepository(repositoryRoot, branchName);

    const repository =
      await McpReviewRepository.fromWorkingDirectory(repositoryRoot);
    const comments = await repository.readComments("all");

    expect(comments.repository.rootPath).toBe(await realpath(repositoryRoot));
    expect(comments.branch).toBe(`refs/heads/${branchName}`);
    expect(comments.threads).toEqual([]);
  });

  it("prunes review state for deleted local branches", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "revloop-mcp-"));
    temporaryDirectories.push(repositoryRoot);
    const branchName = "review-test";
    const currentBranch = `refs/heads/${branchName}`;
    const deletedBranch = "refs/heads/deleted";
    await initializeRepository(repositoryRoot, branchName);
    await execFileAsync("git", ["branch", "deleted"], {
      cwd: repositoryRoot,
    });

    const repository = createRepositoryIdentity(repositoryRoot);
    const store = new JsonReviewStore();
    const currentState = await store.loadBranch(repository, currentBranch);
    currentState.threads.push(
      createThread(currentBranch, "current-thread", "Keep this."),
    );
    await store.saveBranch(currentState, currentState.revision);
    const deletedState = await store.loadBranch(repository, deletedBranch);
    deletedState.threads.push(
      createThread(deletedBranch, "deleted-thread", "Remove this."),
    );
    await store.saveBranch(deletedState, deletedState.revision);
    const deletedFile = path.join(
      repository.storageRoot,
      "branches",
      `${sha256(deletedBranch)}.json`,
    );
    await execFileAsync("git", ["branch", "--delete", "--force", "deleted"], {
      cwd: repositoryRoot,
    });

    const comments = await new McpReviewRepository(repository).readComments(
      "all",
    );

    expect(comments.threads.map((thread) => thread.id)).toEqual([
      "current-thread",
    ]);
    await expect(readFile(deletedFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects repositories without a checked-out branch", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "revloop-mcp-"));
    temporaryDirectories.push(repositoryRoot);
    await initializeRepository(repositoryRoot, "review-test");
    await execFileAsync("git", ["checkout", "--detach"], {
      cwd: repositoryRoot,
    });
    const repository = new McpReviewRepository(
      createRepositoryIdentity(repositoryRoot),
    );

    await expect(repository.readComments()).rejects.toThrow(
      "Revloop MCP requires a checked-out Git branch",
    );
  });

  it("rejects an empty branch name returned by Git", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "revloop-mcp-"));
    temporaryDirectories.push(repositoryRoot);
    await writeFile(
      path.join(repositoryRoot, "symbolic-ref"),
      'process.stdout.write("\\n");\n',
      "utf8",
    );
    const repository = new McpReviewRepository(
      createRepositoryIdentity(repositoryRoot),
      process.execPath,
    );

    await expect(repository.readComments()).rejects.toThrow(
      "Current branch is empty.",
    );
  });
});

function createRepositoryIdentity(repositoryRoot: string): RepositoryIdentity {
  return {
    key: "mcp-test-repository",
    rootPath: repositoryRoot,
    displayName: "revloop",
    storageRoot: path.join(repositoryRoot, ".git", "revloop"),
  };
}

function createThread(branch: string, id: string, body: string) {
  const anchor: AnchorSnapshot = {
    filePath: "src/example.ts",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    selectedText: "value",
    beforeContext: [],
    afterContext: [],
    contentHash: "hash",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
  const input: NewThreadInput = {
    filePath: anchor.filePath,
    languageId: "typescript",
    anchor,
    diffContext: {
      header: "header",
      hunk: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    },
    body,
  };
  return createReviewThread(input, {
    repositoryKey: "mcp-test-repository",
    branch,
    id,
  });
}

async function initializeRepository(
  rootPath: string,
  branchName: string,
): Promise<void> {
  await execFileAsync("git", ["init", `--initial-branch=${branchName}`], {
    cwd: rootPath,
  });
  await execFileAsync("git", ["config", "user.name", "Revloop Test"], {
    cwd: rootPath,
  });
  await execFileAsync("git", ["config", "user.email", "revloop@example.test"], {
    cwd: rootPath,
  });
  await writeFile(path.join(rootPath, "README.md"), "# Test repository\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: rootPath });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], {
    cwd: rootPath,
  });
}
