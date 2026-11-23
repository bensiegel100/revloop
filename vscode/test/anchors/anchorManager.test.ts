import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAnchor } from "../../src/domain/anchorMapper.js";
import {
  AnchorManager,
  canonicalRepositoryRelativePath,
  toSerializedRange,
  toVscodeRange,
} from "../../src/anchors/anchorManager.js";
import type { AnchorThreadRepository } from "../../src/anchors/anchorManager.js";
import type { RepositoryIdentity, ReviewThread } from "@revloop/shared";

const temporaryDirectories: string[] = [];
interface DocumentChangeEvent {
  document: {
    uri: vscode.Uri;
    getText(): string;
  };
}
type DocumentChangeListener = (event: DocumentChangeEvent) => void;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("anchor manager", () => {
  it("maps symlink-opened document events to the canonical repository", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".revloop-symlink-"));
    temporaryDirectories.push(root);
    const repositoryRoot = path.join(root, "canonical-repository");
    const filePath = path.join(repositoryRoot, "src", "index.ts");
    const linkedRoot = path.join(root, "workspace-link");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const value = 1;\n", "utf8");
    await symlink(
      repositoryRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      canonicalRepositoryRelativePath(
        repositoryRoot,
        path.join(linkedRoot, "src", "index.ts"),
      ),
    ).resolves.toBe("src/index.ts");
    await expect(
      canonicalRepositoryRelativePath(repositoryRoot, root),
    ).resolves.toBeUndefined();
  });

  it("captures and converts VS Code ranges", () => {
    const manager = new AnchorManager(createRepository([]), () => 1);
    const range = new vscode.Range(1, 0, 1, 5);

    const anchor = manager.capture(
      { getText: () => "before\nvalue\nafter" },
      "./src/index.ts",
      range,
    );

    expect(anchor.filePath).toBe("src/index.ts");
    expect(anchor.selectedText).toBe("value");
    expect(toSerializedRange(toVscodeRange(anchor.range))).toEqual(
      anchor.range,
    );
    manager.dispose();
  });

  it("remaps anchors from disk and marks unreadable files outdated", async () => {
    const thread = createThread();
    const repository = createRepository([thread]);
    setOpenTextDocument(() =>
      Promise.resolve({
        getText: () => "intro\nbefore\nvalue\nafter",
      }),
    );
    const manager = new AnchorManager(repository, () => 1);

    await manager.remapAll();

    expect(repository.updateAnchor).toHaveBeenCalledWith(
      thread.id,
      expect.objectContaining({
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 5 },
        },
      }),
      "remapped",
      expect.any(Number),
      expect.any(Object),
    );

    repository.updateAnchor.mockClear();
    repository.markOutdated.mockClear();
    setOpenTextDocument(() => Promise.reject(new Error("missing")));
    await manager.remapAll();
    expect(repository.markOutdated).toHaveBeenCalledWith(
      thread.id,
      "Unable to read src/index.ts: missing",
      expect.any(Object),
    );
    manager.dispose();
  });

  it("debounces document changes and remaps edited files", async () => {
    vi.useFakeTimers();
    let changeListener: DocumentChangeListener | undefined;
    setDocumentChangeListener((listener) => {
      changeListener = listener;
    });
    const thread = createThread();
    const repository = createRepository([thread]);
    const manager = new AnchorManager(repository, () => 1);

    changeListener?.({
      document: {
        uri: vscode.Uri.file("/workspace/repository/src/index.ts"),
        getText: () => "intro\nbefore\nvalue\nafter",
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(repository.updateAnchor).toHaveBeenCalledWith(
      thread.id,
      expect.any(Object),
      "edited",
      expect.any(Number),
      expect.any(Object),
    );
    manager.dispose();
  });

  it("stops work after disposal", async () => {
    const repository = createRepository([createThread()]);
    const manager = new AnchorManager(repository, () => 1);
    manager.dispose();

    await manager.remapAll();

    expect(repository.updateAnchor).not.toHaveBeenCalled();
    expect(repository.markOutdated).not.toHaveBeenCalled();
  });
});

function createRepository(threads: readonly ReviewThread[]) {
  const identity: RepositoryIdentity = {
    key: "repository",
    rootPath: "/workspace/repository",
    displayName: "repository",
    storageRoot: "/workspace/repository/.git/revloop",
  };
  const context = {
    generation: 1,
    repositoryKey: identity.key,
    branch: "refs/heads/main",
  };
  return {
    repository: identity,
    captureContext: () => context,
    isCurrent: () => true,
    list: () => threads,
    markOutdated: vi.fn(() => Promise.resolve()),
    updateAnchor: vi.fn(() => Promise.resolve()),
  } satisfies AnchorThreadRepository;
}

function createThread(): ReviewThread {
  const text = "before\nvalue\nafter";
  const anchor = captureAnchor(
    "src/index.ts",
    text,
    {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 5 },
    },
    1,
  );
  return {
    id: "thread-1",
    repositoryKey: "repository",
    branch: "refs/heads/main",
    filePath: anchor.filePath,
    languageId: "typescript",
    status: "open",
    originalAnchor: anchor,
    currentAnchor: anchor,
    anchorHistory: [{ kind: "created", at: anchor.capturedAt }],
    diffContext: {
      header: "header",
      hunk: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    },
    messages: [
      {
        id: "message-1",
        author: "user",
        body: "Review this.",
        createdAt: anchor.capturedAt,
      },
    ],
    createdAt: anchor.capturedAt,
    updatedAt: anchor.capturedAt,
  };
}

function setOpenTextDocument(
  read: (uri: vscode.Uri) => Promise<{ getText(): string }>,
): void {
  Object.defineProperty(vscode.workspace, "openTextDocument", {
    configurable: true,
    value: read,
  });
}

function setDocumentChangeListener(
  onListener: (listener: DocumentChangeListener) => void,
): void {
  Object.defineProperty(vscode.workspace, "onDidChangeTextDocument", {
    configurable: true,
    value: (listener: DocumentChangeListener) => {
      onListener(listener);
      return { dispose: () => undefined };
    },
  });
}
