import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryIdentity } from "@revloop/shared";
import { GitService } from "../../src/git/gitService.js";
import type { ActiveRepository } from "../../src/git/gitService.js";
import { RefType } from "../../src/git/vscodeGitApi.js";
import type {
  GitApi,
  GitExtension,
  Repository,
} from "../../src/git/vscodeGitApi.js";

const gitCli = vi.hoisted(() => ({
  discoverRepositoryIdentity: vi.fn(),
  listTrackedChanges: vi.fn(),
  listUntrackedFilePaths: vi.fn(),
  readTrackedPatch: vi.fn(),
  runGit: vi.fn(),
}));
const untracked = vi.hoisted(() => ({
  readUntrackedFile: vi.fn(),
  readWorkingTreeEntry: vi.fn(),
}));

vi.mock("../../src/git/gitCli.js", () => gitCli);
vi.mock("../../src/git/untrackedFile.js", () => untracked);

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const mock of Object.values(gitCli)) {
    mock.mockReset();
  }
  for (const mock of Object.values(untracked)) {
    mock.mockReset();
  }
  vscode.window.activeTextEditor = undefined;
  setWorkspaceFolders(undefined);
});

describe("Git service", () => {
  it("initializes the built-in Git API and rejects unavailable variants", async () => {
    const service = new GitService(createDocuments());
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValueOnce(undefined);
    await expect(service.initialize()).rejects.toThrow(
      "The built-in VS Code Git extension is not available.",
    );

    const disabled = createGitExtension(createGitApi([]), false);
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValueOnce(disabled);
    await expect(service.initialize()).rejects.toThrow(
      "The built-in VS Code Git extension is disabled.",
    );

    const api = createGitApi([]);
    const inactive = createGitExtension(api, true, false);
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValueOnce(inactive);
    await service.initialize();
    expect(inactive.activate).toHaveBeenCalledOnce();
  });

  it("selects the discovered repository and reads its current head", async () => {
    const repository = createRepository();
    const api = createGitApi([repository]);
    const identity = createIdentity();
    gitCli.discoverRepositoryIdentity.mockResolvedValue(identity);
    gitCli.runGit
      .mockResolvedValueOnce("feature\n")
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("feature\n")
      .mockResolvedValueOnce("def456\n");
    const service = await createInitializedService(api);

    const active = await service.selectRepository();

    expect(active.identity).toEqual(identity);
    expect(active.branch).toBe("refs/heads/feature");
    await expect(service.readCurrentHead(active)).resolves.toEqual({
      branchName: "feature",
      headCommit: "def456",
    });
  });

  it("requires initialization and times out repository discovery", async () => {
    const uninitialized = new GitService(createDocuments());
    await expect(uninitialized.selectRepository()).rejects.toThrow(
      "Git service has not been initialized.",
    );

    vi.useFakeTimers();
    const api = createGitApi([]);
    api.openRepository = vi.fn(() => Promise.resolve(null));
    setWorkspaceFolders([
      {
        uri: vscode.Uri.file("/workspace/repository"),
        name: "repository",
        index: 0,
      },
    ]);
    const service = await createInitializedService(api);
    const selection = service.selectRepository().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    await expect(selection).resolves.toEqual(
      new Error("Open a workspace containing a Git repository first."),
    );
    vi.useRealTimers();
  });

  it("uses the active editor repository when multiple are open", async () => {
    const selected = createRepository("/workspace/selected");
    const api = createGitApi([createRepository("/workspace/other"), selected]);
    api.getRepository = vi.fn(() => selected);
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: {
        document: {
          uri: vscode.Uri.file("/workspace/selected/src/index.ts"),
        },
      },
    });
    gitCli.discoverRepositoryIdentity.mockResolvedValue({
      ...createIdentity(),
      rootPath: "/workspace/selected",
    });
    gitCli.runGit
      .mockResolvedValueOnce("feature\n")
      .mockResolvedValueOnce("abc123\n");
    const service = await createInitializedService(api);

    await expect(service.selectRepository()).resolves.toMatchObject({
      repository: selected,
    });
  });

  it("discovers repositories from workspace folders and handles cancellation", async () => {
    const repositories: Repository[] = [];
    const api = createGitApi(repositories);
    const repository = createRepository();
    api.openRepository = vi.fn(() => {
      repositories.push(repository);
      return Promise.resolve(repository);
    });
    setWorkspaceFolders([
      {
        uri: repository.rootUri,
        name: "repository",
        index: 0,
      },
    ]);
    gitCli.discoverRepositoryIdentity.mockResolvedValue(createIdentity());
    gitCli.runGit
      .mockResolvedValueOnce("main\n")
      .mockResolvedValueOnce("abc123\n");
    const service = await createInitializedService(api);

    await expect(service.selectRepository()).resolves.toMatchObject({
      branchName: "main",
    });

    const multipleApi = createGitApi([
      createRepository("/workspace/one"),
      createRepository("/workspace/two"),
    ]);
    setShowQuickPick(undefined);
    const multiple = await createInitializedService(multipleApi);
    await expect(multiple.selectRepository()).rejects.toThrow(
      "No repository was selected.",
    );
  });

  it("chooses API and CLI branch candidates", async () => {
    const repository = createRepository();
    repository.getBranches = vi
      .fn()
      .mockResolvedValueOnce([{ type: RefType.Head, name: "main" }])
      .mockResolvedValueOnce([
        { type: RefType.RemoteHead, name: "origin/feature" },
      ]);
    const active = createActiveRepository(repository);
    const service = new GitService(createDocuments());
    setShowQuickPick("main");

    await expect(service.chooseBaseBranch(active)).resolves.toBe("main");

    repository.getBranches = vi.fn(() => Promise.reject(new Error("failed")));
    gitCli.runGit.mockResolvedValueOnce("main\norigin/main\n");
    await expect(service.chooseBaseBranch(active)).resolves.toBe("main");

    gitCli.runGit.mockResolvedValueOnce("");
    await expect(service.chooseBaseBranch(active)).rejects.toThrow(
      "No other local or remote branches are available.",
    );
  });

  it("creates working-tree and branch review sources", async () => {
    const repository = createRepository();
    const active = createActiveRepository(repository);
    const service = new GitService(createDocuments());

    expect(service.createWorkingTreeSource(active)).toEqual({
      kind: "working-tree",
      baseCommit: "abc123",
    });
    repository.getMergeBase = vi.fn(() => Promise.resolve("merge-base"));
    await expect(service.createBranchSource(active, "main")).resolves.toEqual({
      kind: "branch",
      baseBranch: "main",
      mergeBase: "merge-base",
    });
    repository.getMergeBase = vi.fn(() => Promise.resolve(undefined));
    await expect(service.createBranchSource(active, "missing")).rejects.toThrow(
      "No merge base exists",
    );
  });

  it("builds tracked and untracked review files", async () => {
    const documents = createDocuments();
    const service = new GitService(documents);
    const active = createActiveRepository(createRepository());
    gitCli.listTrackedChanges.mockResolvedValue([
      { path: "src/added.ts", status: "added" },
      { path: "src/deleted.ts", status: "deleted" },
      {
        path: "src/renamed.ts",
        originalPath: "src/original.ts",
        status: "renamed",
      },
    ]);
    gitCli.readTrackedPatch.mockResolvedValue("@@ -1 +1 @@\n-old\n+new\n");
    untracked.readWorkingTreeEntry.mockImplementation((_identity, filePath) =>
      Promise.resolve({
        snapshotContent: filePath === "src/renamed.ts" ? "snapshot" : undefined,
        canComment: true,
      }),
    );
    gitCli.listUntrackedFilePaths.mockResolvedValue([
      "src/added.ts",
      "src/new.ts",
    ]);
    untracked.readUntrackedFile.mockResolvedValue({
      snapshotContent: "new file",
      canComment: true,
      diff: {
        header: "header",
        hunks: [
          {
            header: "@@ -0,0 +1 @@",
            hunk: "@@ -0,0 +1 @@\n+new file",
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            modifiedLines: [0],
          },
        ],
        binary: false,
      },
    });

    const snapshot = await service.buildSnapshot(active, {
      kind: "working-tree",
      baseCommit: "abc123",
    });

    expect(snapshot.files.map((file) => file.path)).toEqual([
      "src/added.ts",
      "src/deleted.ts",
      "src/new.ts",
      "src/renamed.ts",
    ]);
    expect(
      snapshot.files.find((file) => file.status === "deleted"),
    ).toMatchObject({ canComment: false });
    expect(documents.createSnapshotUri).toHaveBeenCalled();
    expect(documents.createEmptyUri).toHaveBeenCalled();
  });

  it("reports detached and unborn repositories", async () => {
    const service = new GitService(createDocuments());
    const active = createActiveRepository(createRepository());
    gitCli.runGit.mockRejectedValueOnce(new Error("detached"));
    await expect(service.readCurrentHead(active)).rejects.toThrow(
      "Detached HEAD is unsupported.",
    );

    gitCli.runGit
      .mockResolvedValueOnce("main\n")
      .mockRejectedValueOnce(new Error("unborn"));
    await expect(service.readCurrentHead(active)).rejects.toThrow(
      "Repositories without an initial commit are unsupported.",
    );

    gitCli.runGit.mockResolvedValueOnce("\n").mockResolvedValueOnce("abc123\n");
    await expect(service.readCurrentHead(active)).rejects.toThrow(
      "Unable to determine the current Git branch and commit.",
    );
  });
});

async function createInitializedService(api: GitApi): Promise<GitService> {
  const service = new GitService(createDocuments());
  vi.spyOn(vscode.extensions, "getExtension").mockReturnValue(
    createGitExtension(api),
  );
  await service.initialize();
  return service;
}

function createGitExtension(api: GitApi, enabled = true, isActive = true) {
  const extension: GitExtension = {
    enabled,
    onDidChangeEnablement: new vscode.EventEmitter<void>().event,
    getAPI: () => api,
  };
  const activate = vi.fn(() => Promise.resolve(extension));
  return {
    ...extension,
    id: "vscode.git",
    extensionUri: vscode.Uri.file("/extensions/git"),
    extensionPath: "/extensions/git",
    isActive,
    exports: extension,
    packageJSON: {},
    extensionKind: vscode.ExtensionKind.Workspace,
    activate,
  };
}

function createGitApi(repositories: Repository[]): GitApi {
  return {
    state: "initialized",
    onDidChangeState: new vscode.EventEmitter<"uninitialized" | "initialized">()
      .event,
    git: { path: "git" },
    repositories,
    onDidOpenRepository: new vscode.EventEmitter<Repository>().event,
    onDidCloseRepository: new vscode.EventEmitter<Repository>().event,
    toGitUri: (uri, ref) =>
      vscode.Uri.from({ scheme: "git", path: uri.fsPath, query: ref }),
    getRepository: () => null,
    openRepository: () => Promise.resolve(null),
  };
}

function createRepository(rootPath = "/workspace/repository"): Repository {
  return {
    rootUri: vscode.Uri.file(rootPath),
    state: {
      HEAD: { type: RefType.Head, name: "feature", commit: "abc123" },
      refs: [],
      remotes: [],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
      onDidChange: new vscode.EventEmitter<void>().event,
    },
    onDidCheckout: new vscode.EventEmitter<void>().event,
    diffWithHEAD: vi.fn(),
    diffWith: vi.fn(),
    getMergeBase: vi.fn(() => Promise.resolve("merge-base")),
    getBranches: vi.fn(() => Promise.resolve([])),
  };
}

function createActiveRepository(repository: Repository): ActiveRepository {
  return {
    api: createGitApi([repository]),
    repository,
    identity: createIdentity(),
    branchName: "feature",
    branch: "refs/heads/feature",
    headCommit: "abc123",
  };
}

function createIdentity(): RepositoryIdentity {
  return {
    key: "repository",
    rootPath: "/workspace/repository",
    displayName: "repository",
    storageRoot: "/workspace/repository/.git/revloop",
  };
}

function createDocuments() {
  return {
    createEmptyUri: vi.fn((_repositoryKey: string, filePath: string) =>
      vscode.Uri.from({ scheme: "revloop-empty", path: filePath }),
    ),
    createSnapshotUri: vi.fn(
      (_repositoryKey: string, filePath: string, content: string) =>
        vscode.Uri.from({
          scheme: "revloop-snapshot",
          path: filePath,
          query: content,
        }),
    ),
  };
}

function setWorkspaceFolders(
  folders: readonly vscode.WorkspaceFolder[] | undefined,
): void {
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    value: folders,
  });
}

function setShowQuickPick(value: unknown): void {
  Object.defineProperty(vscode.window, "showQuickPick", {
    configurable: true,
    value: () => Promise.resolve(value),
  });
}
