import path from "node:path";
import * as vscode from "vscode";
import { resolveRepositoryPath } from "@revloop/shared";
import type { RepositoryIdentity, ReviewSource } from "@revloop/shared";
import { collectBaseBranchCandidates } from "./branchCandidates.js";
import { parseUnifiedDiff } from "./diffParser.js";
import {
  discoverRepositoryIdentity,
  listLocalBranchRefs,
  listTrackedChanges,
  listUntrackedFilePaths,
  readTrackedPatch,
  runGit,
} from "./gitCli.js";
import type { ReviewDocumentProvider } from "./reviewDocumentProvider.js";
import type { ReviewFile, ReviewSnapshot } from "./types.js";
import { readUntrackedFile, readWorkingTreeEntry } from "./untrackedFile.js";
import { RefType } from "./vscodeGitApi.js";
import type { GitApi, GitExtension, Ref, Repository } from "./vscodeGitApi.js";

export interface ActiveRepository {
  api: GitApi;
  repository: Repository;
  identity: RepositoryIdentity;
  branchName: string;
  branch: string;
  headCommit: string;
}

export class GitService {
  private api: GitApi | undefined;

  public constructor(
    private readonly documents: Pick<
      ReviewDocumentProvider,
      "createEmptyUri" | "createSnapshotUri"
    >,
  ) {}

  public async initialize(): Promise<void> {
    const extension =
      vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (extension === undefined) {
      throw new Error("The built-in VS Code Git extension is not available.");
    }

    const gitExtension = extension.isActive
      ? extension.exports
      : await extension.activate();
    if (!gitExtension.enabled) {
      throw new Error("The built-in VS Code Git extension is disabled.");
    }

    this.api = gitExtension.getAPI(1);
  }

  public async selectRepository(): Promise<ActiveRepository> {
    const api = this.requireApi();
    await waitForRepositories(api);
    if (api.repositories.length === 0) {
      throw new Error("Open a workspace containing a Git repository first.");
    }

    let repository: Repository | undefined;
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri !== undefined) {
      repository = api.getRepository(activeUri) ?? undefined;
    }

    if (repository === undefined && api.repositories.length === 1) {
      repository = api.repositories[0];
    }

    if (repository === undefined) {
      const selected = await vscode.window.showQuickPick(
        api.repositories.map((candidate) => ({
          label: path.basename(candidate.rootUri.fsPath),
          description: candidate.rootUri.fsPath,
          repository: candidate,
        })),
        {
          placeHolder: "Select the repository to review",
        },
      );
      repository = selected?.repository;
    }

    if (repository === undefined) {
      throw new Error("No repository was selected.");
    }

    const identity = await discoverRepositoryIdentity(
      api.git.path,
      repository.rootUri.fsPath,
    );
    const head = await readGitHead(api.git.path, identity.rootPath);

    return {
      api,
      repository,
      identity,
      branchName: head.branchName,
      branch: `refs/heads/${head.branchName}`,
      headCommit: head.headCommit,
    };
  }

  public readCurrentHead(
    active: ActiveRepository,
  ): Promise<{ branchName: string; headCommit: string }> {
    return readGitHead(active.api.git.path, active.identity.rootPath);
  }

  public listLocalBranchRefs(active: ActiveRepository): Promise<string[]> {
    return listLocalBranchRefs(active.api.git.path, active.identity.rootPath);
  }

  public async chooseBaseBranch(
    active: ActiveRepository,
  ): Promise<string | undefined> {
    const currentBranch = active.branchName;

    let queriedRefs: Ref[] = [];
    try {
      const [localBranches, remoteBranches] = await Promise.all([
        active.repository.getBranches({ remote: false }),
        active.repository.getBranches({ remote: true }),
      ]);
      queriedRefs = [...localBranches, ...remoteBranches];
    } catch {
      // Fall through to the Git CLI if the extension API cannot enumerate refs.
    }

    let uniqueRefs = collectBaseBranchCandidates(
      currentBranch,
      queriedRefs,
      active.repository.state.refs.filter(
        (ref) => ref.type === RefType.Head || ref.type === RefType.RemoteHead,
      ),
    );
    if (uniqueRefs.length === 0) {
      const output = await runGit(
        active.api.git.path,
        [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
          "refs/remotes",
        ],
        active.identity.rootPath,
      );
      uniqueRefs = collectBaseBranchCandidates(
        currentBranch,
        output
          .split(/\r?\n/)
          .filter((name) => name.length > 0)
          .map((name) => ({ name })),
      );
    }

    if (uniqueRefs.length === 0) {
      throw new Error("No other local or remote branches are available.");
    }

    const preferred = uniqueRefs.find((ref) =>
      /(^|\/)(main|master)$/.test(ref),
    );
    return vscode.window.showQuickPick(uniqueRefs, {
      placeHolder: "Select the base branch",
      ...(preferred === undefined ? {} : { activeItem: preferred }),
    });
  }

  public createWorkingTreeSource(active: ActiveRepository): ReviewSource {
    return {
      kind: "working-tree",
      baseCommit: active.headCommit,
    };
  }

  public async createBranchSource(
    active: ActiveRepository,
    baseBranch: string,
  ): Promise<ReviewSource> {
    const currentBranch = active.branchName;

    const mergeBase = await active.repository.getMergeBase(
      currentBranch,
      baseBranch,
    );
    if (mergeBase === undefined) {
      throw new Error(
        `No merge base exists between ${currentBranch} and ${baseBranch}.`,
      );
    }

    return {
      kind: "branch",
      baseBranch,
      mergeBase,
    };
  }

  public async buildSnapshot(
    active: ActiveRepository,
    source: ReviewSource,
  ): Promise<ReviewSnapshot> {
    const baseRef =
      source.kind === "working-tree" ? source.baseCommit : source.mergeBase;
    const trackedChanges = await listTrackedChanges(
      active.api.git.path,
      active.identity.rootPath,
      baseRef,
    );
    const trackedFiles = await Promise.all(
      trackedChanges.map(async (change): Promise<ReviewFile> => {
        const filePath = change.path;
        const isDeleted = change.status === "deleted";
        const parsed = parseUnifiedDiff(
          await readTrackedPatch(
            active.api.git.path,
            active.identity.rootPath,
            baseRef,
            change,
          ),
        );
        const workingTreeEntry = isDeleted
          ? undefined
          : await readWorkingTreeEntry(active.identity, filePath);
        const modifiedFileUri =
          workingTreeEntry?.snapshotContent === undefined
            ? vscode.Uri.file(
                resolveRepositoryPath(
                  active.repository.rootUri.fsPath,
                  filePath,
                ),
              )
            : this.documents.createSnapshotUri(
                active.identity.key,
                filePath,
                workingTreeEntry.snapshotContent,
              );
        const originalFileUri = vscode.Uri.file(
          resolveRepositoryPath(
            active.repository.rootUri.fsPath,
            change.originalPath ?? filePath,
          ),
        );
        const baseUri =
          change.status === "added"
            ? this.documents.createEmptyUri(active.identity.key, filePath)
            : active.api.toGitUri(originalFileUri, baseRef);
        const modifiedUri = isDeleted
          ? this.documents.createEmptyUri(active.identity.key, filePath)
          : modifiedFileUri;

        return {
          path: filePath,
          ...(change.originalPath === undefined
            ? {}
            : { originalPath: change.originalPath }),
          status: change.status,
          baseUri,
          modifiedUri,
          diff: parsed,
          canComment:
            !isDeleted &&
            workingTreeEntry?.canComment !== false &&
            !parsed.binary &&
            parsed.hunks.some((hunk) => hunk.modifiedLines.length > 0),
        };
      }),
    );
    const trackedPaths = new Set(trackedFiles.map((file) => file.path));
    const untrackedPaths = await listUntrackedFilePaths(
      active.api.git.path,
      active.identity.rootPath,
    );
    const untrackedFiles = await Promise.all(
      untrackedPaths
        .filter((filePath) => !trackedPaths.has(filePath))
        .map(async (filePath): Promise<ReviewFile> => {
          const untracked = await readUntrackedFile(active.identity, filePath);
          const modifiedUri =
            untracked.snapshotContent === undefined
              ? vscode.Uri.file(
                  resolveRepositoryPath(
                    active.repository.rootUri.fsPath,
                    filePath,
                  ),
                )
              : this.documents.createSnapshotUri(
                  active.identity.key,
                  filePath,
                  untracked.snapshotContent,
                );
          return {
            path: filePath,
            status: "untracked",
            baseUri: this.documents.createEmptyUri(
              active.identity.key,
              filePath,
            ),
            modifiedUri,
            diff: untracked.diff,
            canComment:
              untracked.canComment &&
              !untracked.diff.binary &&
              untracked.diff.hunks.some(
                (hunk) => hunk.modifiedLines.length > 0,
              ),
          };
        }),
    );
    const files = [...trackedFiles, ...untrackedFiles];

    return {
      repository: active.identity,
      branch: active.branch,
      source,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      createdAt: new Date().toISOString(),
    };
  }

  private requireApi(): GitApi {
    if (this.api === undefined) {
      throw new Error("Git service has not been initialized.");
    }

    return this.api;
  }
}

async function waitForRepositories(api: GitApi): Promise<void> {
  if (api.repositories.length > 0) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length === 0) {
    return;
  }

  await Promise.all(
    workspaceFolders.map(async (folder) => {
      try {
        await api.openRepository(folder.uri);
      } catch {
        // Repository discovery can still complete through the Git extension events.
      }
    }),
  );
  if (api.repositories.length > 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      openSubscription.dispose();
      stateSubscription.dispose();
      resolve();
    };
    const openSubscription = api.onDidOpenRepository(() => {
      if (api.repositories.length > 0) {
        finish();
      }
    });
    const stateSubscription = api.onDidChangeState(() => {
      if (api.state === "initialized" && api.repositories.length > 0) {
        finish();
      }
    });
    const timeout = setTimeout(finish, 5_000);

    if (api.repositories.length > 0) {
      finish();
    }
  });
}

async function readGitHead(
  executable: string,
  cwd: string,
): Promise<{ branchName: string; headCommit: string }> {
  let branchName: string;
  try {
    branchName = (
      await runGit(
        executable,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd,
      )
    ).trim();
  } catch {
    throw new Error("Detached HEAD is unsupported.");
  }

  let headCommit: string;
  try {
    headCommit = (
      await runGit(executable, ["rev-parse", "--verify", "HEAD"], cwd)
    ).trim();
  } catch {
    throw new Error("Repositories without an initial commit are unsupported.");
  }

  if (branchName.length === 0 || headCommit.length === 0) {
    throw new Error("Unable to determine the current Git branch and commit.");
  }

  return { branchName, headCommit };
}
