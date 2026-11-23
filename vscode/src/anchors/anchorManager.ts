import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { normalizeRepositoryRelativePath } from "@revloop/shared";
import type {
  AnchorSnapshot,
  ReviewThread,
  SerializedRange,
} from "@revloop/shared";
import { captureAnchor, remapAnchor } from "../domain/anchorMapper.js";
import { rangesEqual } from "../domain/ranges.js";
import { StaleThreadRepositoryContextError } from "../storage/threadRepository.js";
import type {
  ThreadRepository,
  ThreadRepositoryContext,
} from "../storage/threadRepository.js";

export type AnchorThreadRepository = Pick<
  ThreadRepository,
  | "captureContext"
  | "isCurrent"
  | "list"
  | "markOutdated"
  | "repository"
  | "updateAnchor"
>;

export class AnchorManager implements vscode.Disposable {
  private readonly pendingFiles = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repositoryContext: ThreadRepositoryContext;
  private readonly repositoryRoot: string;
  private disposed = false;

  public constructor(
    private readonly threads: AnchorThreadRepository,
    private readonly contextLines: () => number,
  ) {
    this.repositoryContext = threads.captureContext();
    this.repositoryRoot = threads.repository.rootPath;
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme !== "file") {
          return;
        }

        const text = event.document.getText();
        void this.handleDocumentChange(event.document.uri, text).catch(
          (error: unknown) => {
            this.reportUnexpectedError(error);
          },
        );
      }),
    );
  }

  public capture(
    document: Pick<vscode.TextDocument, "getText">,
    filePath: string,
    range: vscode.Range,
  ): AnchorSnapshot {
    return captureAnchor(
      normalizeRepositoryRelativePath(filePath),
      document.getText(),
      toSerializedRange(range),
      this.contextLines(),
    );
  }

  public async remapAll(): Promise<void> {
    for (const thread of this.threads.list()) {
      if (!this.isActive()) {
        return;
      }
      await this.remapThreadFromDisk(thread);
    }
  }

  public dispose(): void {
    this.disposed = true;
    for (const timeout of this.pendingFiles.values()) {
      clearTimeout(timeout);
    }
    this.pendingFiles.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private scheduleRemap(filePath: string, text: string): void {
    if (!this.isActive()) {
      return;
    }

    const existing = this.pendingFiles.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    this.pendingFiles.set(
      filePath,
      setTimeout(() => {
        this.pendingFiles.delete(filePath);
        if (!this.isActive()) {
          return;
        }
        void this.remapFile(filePath, text).catch((error: unknown) => {
          this.reportUnexpectedError(error);
        });
      }, 250),
    );
  }

  private async remapFile(filePath: string, text: string): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    const candidates = this.threads
      .list()
      .filter(
        (thread) =>
          thread.filePath === filePath &&
          thread.status !== "resolved" &&
          thread.currentAnchor !== null,
      );

    for (const thread of candidates) {
      if (!this.isActive()) {
        return;
      }
      await this.applyRemap(thread, text, "edited");
    }
  }

  private async remapThreadFromDisk(thread: ReviewThread): Promise<void> {
    if (thread.status === "resolved" || !this.isActive()) {
      return;
    }

    const uri = vscode.Uri.file(
      path.join(this.repositoryRoot, thread.filePath),
    );
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (!this.isActive()) {
        return;
      }
      await this.applyRemap(thread, document.getText(), "remapped");
    } catch (error: unknown) {
      if (!this.isActive()) {
        return;
      }
      await this.threads.markOutdated(
        thread.id,
        `Unable to read ${thread.filePath}: ${toErrorMessage(error)}`,
        this.repositoryContext,
      );
    }
  }

  private async applyRemap(
    thread: ReviewThread,
    text: string,
    kind: "edited" | "remapped",
  ): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    const sourceAnchor = thread.currentAnchor ?? thread.originalAnchor;
    const match = remapAnchor(sourceAnchor, text);
    if (!this.isActive()) {
      return;
    }
    if (match.anchor === null) {
      await this.threads.markOutdated(
        thread.id,
        match.reason ?? "The anchor could not be remapped.",
        this.repositoryContext,
      );
      return;
    }

    if (
      thread.currentAnchor !== null &&
      anchorsHaveSameLocationAndContext(thread.currentAnchor, match.anchor)
    ) {
      return;
    }

    await this.threads.updateAnchor(
      thread.id,
      match.anchor,
      kind,
      match.confidence,
      this.repositoryContext,
    );
  }

  private async handleDocumentChange(
    uri: vscode.Uri,
    text: string,
  ): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    const filePath = await this.toRelativePath(uri);
    if (filePath !== undefined && this.isActive()) {
      this.scheduleRemap(filePath, text);
    }
  }

  private async toRelativePath(uri: vscode.Uri): Promise<string | undefined> {
    return canonicalRepositoryRelativePath(this.repositoryRoot, uri.fsPath);
  }

  private isActive(): boolean {
    return !this.disposed && this.threads.isCurrent(this.repositoryContext);
  }

  private reportUnexpectedError(error: unknown): void {
    if (this.disposed || error instanceof StaleThreadRepositoryContextError) {
      return;
    }

    void vscode.window.showErrorMessage(toErrorMessage(error));
  }
}

export async function canonicalRepositoryRelativePath(
  repositoryRoot: string,
  filePath: string,
): Promise<string | undefined> {
  let canonicalPath = filePath;
  try {
    canonicalPath = await realpath(canonicalPath);
  } catch {
    // The raw path is still usable for canonical, existing workspaces.
  }

  const relative = path.relative(repositoryRoot, canonicalPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  return normalizeRepositoryRelativePath(relative);
}

export function toVscodeRange(range: SerializedRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

export function toSerializedRange(range: vscode.Range): SerializedRange {
  return {
    start: {
      line: range.start.line,
      character: range.start.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function anchorsHaveSameLocationAndContext(
  left: AnchorSnapshot,
  right: AnchorSnapshot,
): boolean {
  return (
    left.filePath === right.filePath &&
    left.selectedText === right.selectedText &&
    rangesEqual(left.range, right.range) &&
    arraysEqual(left.beforeContext, right.beforeContext) &&
    arraysEqual(left.afterContext, right.afterContext)
  );
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
