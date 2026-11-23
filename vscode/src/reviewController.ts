import path from "node:path";
import * as vscode from "vscode";
import { resolveRepositoryPath } from "@revloop/shared";
import type { ReviewSource, ReviewThread } from "@revloop/shared";
import { AnchorManager } from "./anchors/anchorManager.js";
import type { AnchorThreadRepository } from "./anchors/anchorManager.js";
import type { ActiveRepository, GitService } from "./git/gitService.js";
import type { ReviewFile, ReviewSnapshot } from "./git/types.js";
import type { ReviewDocumentProvider } from "./git/reviewDocumentProvider.js";
import type { ThreadRepository } from "./storage/threadRepository.js";
import { canonicalizeReviewSnapshot, ReviewComments } from "./ui/comments.js";
import type { ReviewCommentsRepository } from "./ui/comments.js";
import { ReviewFileItem, ReviewTreeProvider } from "./ui/reviewTree.js";
import type { ReviewTreeNode, ReviewTreeRepository } from "./ui/reviewTree.js";

type ReviewControllerContext = Pick<vscode.ExtensionContext, "subscriptions">;
type ReviewControllerGitService = Pick<
  GitService,
  | "buildSnapshot"
  | "chooseBaseBranch"
  | "createBranchSource"
  | "createWorkingTreeSource"
  | "initialize"
  | "listLocalBranchRefs"
  | "readCurrentHead"
  | "selectRepository"
>;
type ReviewControllerThreadRepository = Pick<
  ThreadRepository,
  "get" | "isCurrent" | "list" | "open" | "pruneBranchStates" | "suspend"
> &
  AnchorThreadRepository &
  ReviewCommentsRepository &
  ReviewTreeRepository;
type ReviewControllerDocuments = Pick<
  ReviewDocumentProvider,
  "createHistoricalDocument"
>;

export class ReviewController implements vscode.Disposable {
  private activeRepository: ActiveRepository | undefined;
  private snapshot: ReviewSnapshot | undefined;
  private anchors: AnchorManager | undefined;
  private comments: ReviewComments | undefined;
  private readonly tree: ReviewTreeProvider;
  private readonly treeView: vscode.TreeView<ReviewTreeNode>;
  private repositoryStateSubscription: vscode.Disposable | undefined;
  private refreshQueue: Promise<void> = Promise.resolve();
  private currentSource: ReviewSource | undefined;
  private lifecycleGeneration = 0;
  private reviewEnabled = false;

  public constructor(
    private readonly context: ReviewControllerContext,
    private readonly git: ReviewControllerGitService,
    private readonly threads: ReviewControllerThreadRepository,
    private readonly documents: ReviewControllerDocuments,
  ) {
    this.tree = new ReviewTreeProvider(threads);
    this.treeView = vscode.window.createTreeView("revloop.threads", {
      treeDataProvider: this.tree,
      showCollapseAll: true,
    });
    context.subscriptions.push(this.tree, this.treeView);
  }

  public async initialize(): Promise<void> {
    await this.git.initialize();
    try {
      await this.selectAndOpenRepository();
    } catch (error: unknown) {
      if (isUnsupportedHeadError(error)) {
        this.disableReview();
        return;
      }
      throw error;
    }
    await this.startWorkingTreeReview();
  }

  public async startWorkingTreeReview(): Promise<void> {
    const active = await this.ensureRepository();
    this.currentSource = this.git.createWorkingTreeSource(active);
    await this.refreshSnapshot();
  }

  public async startBranchReview(): Promise<void> {
    const active = await this.ensureRepository();
    const baseBranch = await this.git.chooseBaseBranch(active);
    if (baseBranch === undefined) {
      return;
    }

    this.currentSource = await this.git.createBranchSource(active, baseBranch);
    await this.refreshSnapshot();
  }

  public async refresh(): Promise<void> {
    await this.enqueueRefresh(async () => {
      const active = await this.ensureRepository();
      let head: { branchName: string; headCommit: string };
      try {
        head = await this.git.readCurrentHead(active);
      } catch (error: unknown) {
        if (isUnsupportedHeadError(error)) {
          this.disableReview();
          return;
        }
        throw error;
      }

      const branch = `refs/heads/${head.branchName}`;
      const branchChanged = branch !== active.branch;
      active.branchName = head.branchName;
      active.branch = branch;
      active.headCommit = head.headCommit;
      await this.pruneDeletedBranchReviews(active);

      if (branchChanged || !this.reviewEnabled) {
        const activated = await this.activateReview(active);
        if (!activated) {
          return;
        }
      }

      if (branchChanged || this.currentSource?.kind === "working-tree") {
        this.currentSource = this.git.createWorkingTreeSource(active);
      } else if (this.currentSource?.kind === "branch") {
        this.currentSource = await this.git.createBranchSource(
          active,
          this.currentSource.baseBranch,
        );
      }

      await this.refreshSnapshotImmediately(this.lifecycleGeneration);
    });
  }

  public async addThread(): Promise<void> {
    await this.requireComments().addFromActiveEditor();
  }

  public async reply(reply: vscode.CommentReply): Promise<void> {
    await this.requireComments().handleReply(reply);
  }

  public editComment(argument: unknown): Promise<void> {
    this.requireComments().editComment(argument);
    return Promise.resolve();
  }

  public async saveComment(argument: unknown): Promise<void> {
    await this.requireComments().saveComment(argument);
  }

  public cancelCommentEdit(argument: unknown): Promise<void> {
    this.requireComments().cancelCommentEdit(argument);
    return Promise.resolve();
  }

  public async resolve(argument: unknown): Promise<void> {
    await this.requireComments().resolve(argument);
  }

  public async reopen(argument: unknown): Promise<void> {
    await this.requireComments().reopen(argument);
  }

  public async openThread(argument: unknown): Promise<void> {
    const thread = resolveThreadArgument(argument, this.threads);
    if (thread === undefined) {
      throw new Error("No review thread was supplied.");
    }

    const file = this.snapshot?.files.find(
      (candidate) => candidate.path === thread.filePath,
    );
    if (file !== undefined && thread.currentAnchor !== null) {
      await this.openDiff(file);
      const activeEditor = vscode.window.activeTextEditor;
      const anchor = thread.currentAnchor;
      if (
        activeEditor !== undefined &&
        refersToSameDocument(activeEditor.document.uri, file.modifiedUri)
      ) {
        activeEditor.selection = new vscode.Selection(
          anchor.range.start.line,
          anchor.range.start.character,
          anchor.range.end.line,
          anchor.range.end.character,
        );
        activeEditor.revealRange(
          activeEditor.selection,
          vscode.TextEditorRevealType.InCenter,
        );
      }
      this.requireComments().expand(thread.id);
    } else {
      await this.requireComments().reveal(thread.id);
    }
  }

  public async openFile(argument: unknown): Promise<void> {
    const item = argument instanceof ReviewFileItem ? argument : undefined;
    const file =
      item?.file ??
      (typeof argument === "string"
        ? this.snapshot?.files.find((candidate) => candidate.path === argument)
        : undefined);
    if (file !== undefined) {
      await this.openDiff(file);
      return;
    }

    if (item !== undefined) {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(
          resolveRepositoryPath(
            this.threads.repository.rootPath,
            item.filePath,
          ),
        ),
      );
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }

    throw new Error("No review file was supplied.");
  }

  public async openDiff(file: ReviewFile): Promise<void> {
    await vscode.commands.executeCommand(
      "vscode.diff",
      file.baseUri,
      file.modifiedUri,
      `${file.path} (${this.describeSource()})`,
      {
        preview: true,
      },
    );
  }

  public getOpenThreads(): readonly ReviewThread[] {
    return this.threads.list().filter((thread) => thread.status === "open");
  }

  public getSnapshot(): ReviewSnapshot | undefined {
    return this.snapshot;
  }

  public dispose(): void {
    this.repositoryStateSubscription?.dispose();
    this.disposeReviewResources();
  }

  private async selectAndOpenRepository(): Promise<void> {
    const active = await this.git.selectRepository();
    this.activeRepository = active;

    this.repositoryStateSubscription?.dispose();
    this.repositoryStateSubscription = active.repository.state.onDidChange(
      () => {
        const head = active.repository.state.HEAD;
        if (head?.name === undefined || head.name !== active.branchName) {
          this.disableReview();
        }
        void this.refresh().catch((error: unknown) => {
          showError(error);
        });
      },
    );

    await this.pruneDeletedBranchReviews(active);
    await this.activateReview(active);
  }

  private async refreshSnapshot(): Promise<void> {
    const generation = this.lifecycleGeneration;
    await this.enqueueRefresh(() =>
      this.refreshSnapshotImmediately(generation),
    );
  }

  private async refreshSnapshotImmediately(generation: number): Promise<void> {
    if (!this.isReviewGenerationActive(generation)) {
      return;
    }

    const active = await this.ensureRepository();
    this.currentSource ??= this.git.createWorkingTreeSource(active);

    const snapshot = canonicalizeReviewSnapshot(
      await this.git.buildSnapshot(active, this.currentSource),
    );
    if (!this.isReviewGenerationActive(generation)) {
      return;
    }

    this.snapshot = snapshot;
    await this.anchors?.remapAll();
    if (!this.isReviewGenerationActive(generation)) {
      return;
    }

    this.tree.setSnapshot(this.snapshot);
    this.treeView.description = this.describeSource();
    this.requireComments().setSnapshot(this.snapshot);
    await vscode.commands.executeCommand(
      "setContext",
      "revloop.reviewActive",
      true,
    );
  }

  private async activateReview(active: ActiveRepository): Promise<boolean> {
    const generation = this.beginReviewTransition();
    const threadContext = await this.threads.open(
      active.identity,
      active.branch,
    );
    if (generation !== this.lifecycleGeneration) {
      if (threadContext !== undefined) {
        this.threads.suspend(threadContext);
      }
      return false;
    }
    if (threadContext === undefined || !this.threads.isCurrent(threadContext)) {
      return false;
    }

    this.anchors = new AnchorManager(this.threads, () =>
      vscode.workspace
        .getConfiguration("revloop")
        .get<number>("anchor.contextLines", 3),
    );
    this.comments = new ReviewComments(
      this.threads,
      this.anchors,
      this.documents,
    );
    this.reviewEnabled = true;
    this.context.subscriptions.push(this.anchors, this.comments);
    await this.anchors.remapAll();
    return this.isReviewGenerationActive(generation);
  }

  private async pruneDeletedBranchReviews(
    active: ActiveRepository,
  ): Promise<void> {
    const branches = new Set(await this.git.listLocalBranchRefs(active));
    branches.add(active.branch);
    await this.threads.pruneBranchStates(active.identity, [...branches]);
  }

  private beginReviewTransition(): number {
    this.lifecycleGeneration += 1;
    this.reviewEnabled = false;
    this.disposeReviewResources();
    this.threads.suspend();
    this.snapshot = undefined;
    this.tree.setSnapshot(undefined);
    void vscode.commands.executeCommand(
      "setContext",
      "revloop.reviewActive",
      false,
    );
    return this.lifecycleGeneration;
  }

  private disableReview(): void {
    this.beginReviewTransition();
    this.treeView.description = "Checkout a named branch to review";
  }

  private disposeReviewResources(): void {
    this.comments?.dispose();
    this.comments = undefined;
    this.anchors?.dispose();
    this.anchors = undefined;
  }

  private isReviewGenerationActive(generation: number): boolean {
    return this.reviewEnabled && generation === this.lifecycleGeneration;
  }

  private enqueueRefresh(operation: () => Promise<void>): Promise<void> {
    const queued = this.refreshQueue.then(operation);
    this.refreshQueue = queued.catch(() => undefined);
    return queued;
  }

  private async ensureRepository(): Promise<ActiveRepository> {
    if (this.activeRepository === undefined) {
      await this.selectAndOpenRepository();
    }
    if (this.activeRepository === undefined) {
      throw new Error("No active repository is available.");
    }

    return this.activeRepository;
  }

  private requireComments(): ReviewComments {
    if (this.comments === undefined) {
      throw new Error("Review comments are not initialized.");
    }
    return this.comments;
  }

  private describeSource(): string {
    if (this.currentSource?.kind === "branch") {
      return `branch vs ${this.currentSource.baseBranch}`;
    }
    return "working tree";
  }
}

function resolveThreadArgument(
  argument: unknown,
  repository: Pick<ThreadRepository, "get">,
): ReviewThread | undefined {
  if (typeof argument === "string") {
    return repository.get(argument);
  }
  if (
    typeof argument === "object" &&
    argument !== null &&
    "thread" in argument
  ) {
    const thread = argument.thread;
    if (
      typeof thread === "object" &&
      thread !== null &&
      "id" in thread &&
      typeof thread.id === "string"
    ) {
      return repository.get(thread.id);
    }
  }
  return undefined;
}

function showError(error: unknown): void {
  void vscode.window.showErrorMessage(
    error instanceof Error ? error.message : String(error),
  );
}

function isUnsupportedHeadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === "Detached HEAD is unsupported." ||
    error.message === "Repositories without an initial commit are unsupported."
  );
}

function refersToSameDocument(left: vscode.Uri, right: vscode.Uri): boolean {
  if (left.scheme !== right.scheme) {
    return false;
  }
  return left.scheme === "file"
    ? path.relative(left.fsPath, right.fsPath) === ""
    : left.toString() === right.toString();
}
