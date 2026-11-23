import * as vscode from "vscode";
import type { ReviewThread } from "@revloop/shared";
import type { ReviewFile, ReviewSnapshot } from "../git/types.js";
import type { ThreadRepository } from "../storage/threadRepository.js";

export type ReviewTreeNode =
  ReviewDirectoryItem | ReviewFileItem | ReviewThreadItem;
export type ReviewTreeRepository = Pick<
  ThreadRepository,
  "list" | "onDidChange"
>;

export class ReviewDirectoryItem extends vscode.TreeItem {
  public constructor(
    public readonly directoryPath: string,
    public readonly children: readonly ReviewTreeNode[],
  ) {
    super(baseName(directoryPath), vscode.TreeItemCollapsibleState.Expanded);
    this.tooltip = directoryPath;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = "revloop.directory";
  }
}

export class ReviewFileItem extends vscode.TreeItem {
  public readonly children: readonly ReviewThreadItem[];

  public constructor(
    public readonly filePath: string,
    public readonly threads: readonly ReviewThread[],
    public readonly file?: ReviewFile,
  ) {
    super(
      baseName(filePath),
      threads.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    this.children = threads.map((thread) => new ReviewThreadItem(thread));
    this.tooltip = filePath;
    if (threads.length > 0) {
      this.description = String(threads.length);
    }
    this.iconPath = fileIcon(file);
    this.contextValue = "revloop.file";
    if (file !== undefined || threads.length > 0) {
      this.command = {
        command: "revloop.openFile",
        title: "Open Review File",
        arguments: [this],
      };
    }
  }
}

export class ReviewThreadItem extends vscode.TreeItem {
  public constructor(public readonly thread: ReviewThread) {
    super(threadLabel(thread), vscode.TreeItemCollapsibleState.None);
    this.tooltip = firstHumanComment(thread);
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
    this.contextValue = "revloop.thread";
    this.command = {
      command: "revloop.openThread",
      title: "Open Review Thread",
      arguments: [this],
    };
  }
}

export class ReviewTreeProvider
  implements vscode.TreeDataProvider<ReviewTreeNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    ReviewTreeNode | undefined
  >();
  private snapshot: ReviewSnapshot | undefined;
  private threads: readonly ReviewThread[] = [];
  private readonly threadSubscription: { dispose(): void };

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly repository: ReviewTreeRepository) {
    this.threadSubscription = repository.onDidChange((threads) => {
      this.threads = threads;
      this.changeEmitter.fire(undefined);
    });
  }

  public setSnapshot(snapshot: ReviewSnapshot | undefined): void {
    this.snapshot = snapshot;
    this.threads = this.repository.list();
    this.changeEmitter.fire(undefined);
  }

  public refresh(): void {
    this.threads = this.repository.list();
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(element: ReviewTreeNode): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ReviewTreeNode): ReviewTreeNode[] {
    if (element instanceof ReviewDirectoryItem) {
      return [...element.children];
    }
    if (element instanceof ReviewFileItem) {
      return [...element.children];
    }
    if (element instanceof ReviewThreadItem) {
      return [];
    }

    return buildTree(this.snapshot?.files ?? [], this.threads);
  }

  public dispose(): void {
    this.threadSubscription.dispose();
    this.changeEmitter.dispose();
  }
}

interface MutableDirectory {
  readonly path: string;
  readonly directories: Map<string, MutableDirectory>;
  readonly files: ReviewFileItem[];
}

function buildTree(
  snapshotFiles: readonly ReviewFile[],
  threads: readonly ReviewThread[],
): ReviewTreeNode[] {
  const groupedThreads = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    const current = groupedThreads.get(thread.filePath) ?? [];
    current.push(thread);
    groupedThreads.set(thread.filePath, current);
  }

  const files = snapshotFiles.map(
    (file) =>
      new ReviewFileItem(
        file.path,
        sortedThreads(groupedThreads.get(file.path) ?? []),
        file,
      ),
  );
  const snapshotPaths = new Set(snapshotFiles.map((file) => file.path));
  for (const [filePath, fileThreads] of groupedThreads) {
    if (!snapshotPaths.has(filePath)) {
      files.push(new ReviewFileItem(filePath, sortedThreads(fileThreads)));
    }
  }

  const root: MutableDirectory = {
    path: "",
    directories: new Map(),
    files: [],
  };
  for (const file of files) {
    const segments = file.filePath.split("/");
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      const directoryPath =
        directory.path.length === 0 ? segment : `${directory.path}/${segment}`;
      let child = directory.directories.get(segment);
      if (child === undefined) {
        child = {
          path: directoryPath,
          directories: new Map(),
          files: [],
        };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }

  return materializeChildren(root);
}

function materializeChildren(directory: MutableDirectory): ReviewTreeNode[] {
  const directories = [...directory.directories.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(
      (child) =>
        new ReviewDirectoryItem(child.path, materializeChildren(child)),
    );
  const files = directory.files
    .slice()
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  return [...directories, ...files];
}

function sortedThreads(threads: readonly ReviewThread[]): ReviewThread[] {
  return threads.slice().sort((left, right) => {
    const lineDifference = threadLine(left) - threadLine(right);
    return lineDifference !== 0
      ? lineDifference
      : left.createdAt.localeCompare(right.createdAt);
  });
}

function threadLine(thread: ReviewThread): number {
  return (thread.currentAnchor ?? thread.originalAnchor).range.start.line;
}

function baseName(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

function threadLabel(thread: ReviewThread): string {
  const line =
    firstHumanComment(thread).split(/\r?\n/, 1)[0] ?? "Review thread";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function firstHumanComment(thread: ReviewThread): string {
  return (
    thread.messages.find((message) => message.author === "user")?.body ??
    "Review thread"
  );
}

function fileIcon(file: ReviewFile | undefined): vscode.ThemeIcon {
  switch (file?.status) {
    case "added":
    case "untracked":
      return new vscode.ThemeIcon(
        "diff-added",
        new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      );
    case "deleted":
      return new vscode.ThemeIcon(
        "diff-removed",
        new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
      );
    case "renamed":
      return new vscode.ThemeIcon(
        "diff-renamed",
        new vscode.ThemeColor("gitDecoration.renamedResourceForeground"),
      );
    case "modified":
    case "type-changed":
      return new vscode.ThemeIcon(
        "diff-modified",
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      );
    case undefined:
      return new vscode.ThemeIcon("file-code");
  }
}
