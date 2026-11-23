import { isDeepStrictEqual } from "node:util";
import {
  appendUserMessage,
  ConcurrentReviewStateError,
  createReviewThread,
  editUserMessage,
  normalizeRepositoryRelativePath,
  markThreadOutdated,
  reopenThread,
  resolveThread,
  updateThreadAnchor,
} from "@revloop/shared";
import type {
  AnchorSnapshot,
  BranchReviewState,
  NewThreadInput,
  RepositoryIdentity,
  ReviewMessage,
  ReviewThread,
} from "@revloop/shared";

type ChangeListener = (threads: readonly ReviewThread[]) => void;

const maxMutationAttempts = 3;

export interface ThreadRepositoryContext {
  generation: number;
  repositoryKey: string;
  branch: string;
}

interface ReviewStore {
  loadBranch(
    repository: RepositoryIdentity,
    branch: string,
  ): Promise<BranchReviewState>;
  saveBranch(
    state: BranchReviewState,
    expectedRevision: number,
  ): Promise<BranchReviewState>;
}

export class StaleThreadRepositoryContextError extends Error {
  public constructor() {
    super("The active Revloop repository or branch changed.");
    this.name = "StaleThreadRepositoryContextError";
  }
}

export class ThreadRepository {
  private state: BranchReviewState | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<ChangeListener>();
  private externalSyncTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private active = false;

  public constructor(private readonly store: ReviewStore) {}

  public async open(
    repository: RepositoryIdentity,
    branch: string,
  ): Promise<ThreadRepositoryContext | undefined> {
    const generation = ++this.generation;
    this.active = false;
    this.stopExternalSync();
    let openedContext: ThreadRepositoryContext | undefined;
    const operation = this.mutationQueue.then(async () => {
      const state = await this.store.loadBranch(repository, branch);
      if (generation !== this.generation) {
        return;
      }

      this.state = state;
      this.active = true;
      this.startExternalSync();
      this.emit();
      openedContext = {
        generation,
        repositoryKey: repository.key,
        branch,
      };
    });

    this.trackOperation(operation);
    await operation;
    return openedContext;
  }

  public get repository(): RepositoryIdentity {
    return this.requireState().repository;
  }

  public get branch(): string {
    return this.requireState().branch;
  }

  public list(): readonly ReviewThread[] {
    return this.state === undefined ? [] : structuredClone(this.state.threads);
  }

  public get(threadId: string): ReviewThread | undefined {
    const thread = this.requireState().threads.find(
      (candidate) => candidate.id === threadId,
    );
    return thread === undefined ? undefined : structuredClone(thread);
  }

  public onDidChange(listener: ChangeListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public captureContext(): ThreadRepositoryContext {
    if (!this.active) {
      throw new StaleThreadRepositoryContextError();
    }

    const state = this.requireState();
    return {
      generation: this.generation,
      repositoryKey: state.repository.key,
      branch: state.branch,
    };
  }

  public isCurrent(context: ThreadRepositoryContext): boolean {
    return (
      this.active &&
      context.generation === this.generation &&
      context.repositoryKey === this.state?.repository.key &&
      context.branch === this.state.branch
    );
  }

  public create(input: NewThreadInput): Promise<ReviewThread> {
    return this.mutate((state) => {
      const normalizedInput: NewThreadInput = {
        ...input,
        filePath: normalizeRepositoryRelativePath(input.filePath),
        anchor: {
          ...input.anchor,
          filePath: normalizeRepositoryRelativePath(input.anchor.filePath),
        },
      };
      const thread = createReviewThread(normalizedInput, {
        repositoryKey: state.repository.key,
        branch: state.branch,
      });
      state.threads.push(thread);
      return structuredClone(thread);
    });
  }

  public appendUserReply(
    threadId: string,
    body: string,
  ): Promise<ReviewMessage> {
    return this.mutate((state) => {
      const thread = requireThread(state, threadId);
      return structuredClone(appendUserMessage(thread, body));
    });
  }

  public editUserMessage(
    threadId: string,
    messageId: string,
    body: string,
    expectedBody: string,
  ): Promise<ReviewMessage> {
    return this.mutate((state) => {
      const thread = requireThread(state, threadId);
      return structuredClone(
        editUserMessage(thread, messageId, body, expectedBody),
      );
    });
  }

  public resolve(threadId: string): Promise<void> {
    return this.mutate((state) => {
      resolveThread(requireThread(state, threadId));
    });
  }

  public reopen(threadId: string): Promise<void> {
    return this.mutate((state) => {
      reopenThread(requireThread(state, threadId));
    });
  }

  public updateAnchor(
    threadId: string,
    anchor: AnchorSnapshot,
    kind: "edited" | "remapped",
    confidence?: number,
    context?: ThreadRepositoryContext,
  ): Promise<void> {
    return this.mutate((state) => {
      const normalizedAnchor: AnchorSnapshot = {
        ...anchor,
        filePath: normalizeRepositoryRelativePath(anchor.filePath),
      };
      updateThreadAnchor(
        requireThread(state, threadId),
        normalizedAnchor,
        kind,
        confidence,
      );
    }, context);
  }

  public markOutdated(
    threadId: string,
    reason: string,
    context?: ThreadRepositoryContext,
  ): Promise<void> {
    return this.mutate((state) => {
      markThreadOutdated(requireThread(state, threadId), reason);
    }, context);
  }

  public suspend(context?: ThreadRepositoryContext): boolean {
    if (context !== undefined && !this.isCurrent(context)) {
      return false;
    }

    this.generation += 1;
    this.active = false;
    this.stopExternalSync();
    return true;
  }

  public dispose(): void {
    this.suspend();
    this.listeners.clear();
  }

  private mutate<T>(
    mutation: (state: BranchReviewState) => T,
    requestedContext?: ThreadRepositoryContext,
  ): Promise<T> {
    const context = requestedContext ?? this.captureContext();
    const operation = this.mutationQueue.then(async () => {
      for (let attempt = 0; attempt < maxMutationAttempts; attempt += 1) {
        this.assertCurrent(context);
        const current = this.requireState();
        const next = structuredClone(current);
        const result = mutation(next);
        if (isDeepStrictEqual(next, current)) {
          return result;
        }

        this.assertCurrent(context);
        try {
          const saved = await this.store.saveBranch(next, current.revision);
          this.assertCurrent(context);
          this.state = saved;
          this.emit();
          return result;
        } catch (error: unknown) {
          if (
            !(error instanceof ConcurrentReviewStateError) ||
            attempt === maxMutationAttempts - 1
          ) {
            throw error;
          }

          this.assertCurrent(context);
          const latest = await this.store.loadBranch(
            current.repository,
            current.branch,
          );
          this.assertCurrent(context);
          const changed = !isDeepStrictEqual(latest, current);
          this.state = latest;
          if (changed) {
            this.emit();
          }
        }
      }

      throw new Error("Unable to persist the review state.");
    });

    this.trackOperation(operation);
    return operation;
  }

  private emit(): void {
    const snapshot =
      this.state === undefined ? [] : structuredClone(this.state.threads);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private startExternalSync(): void {
    if (this.externalSyncTimer !== undefined) {
      return;
    }

    this.externalSyncTimer = setInterval(() => {
      void this.syncExternalChanges();
    }, 500);
    this.externalSyncTimer.unref();
  }

  private async syncExternalChanges(): Promise<void> {
    if (!this.active) {
      return;
    }

    const context = this.captureContext();
    const operation = this.mutationQueue.then(async () => {
      if (!this.isCurrent(context)) {
        return;
      }

      const current = this.requireState();
      const latest = await this.store.loadBranch(
        current.repository,
        current.branch,
      );
      if (this.isCurrent(context) && latest.revision > current.revision) {
        this.state = latest;
        this.emit();
      }
    });

    this.trackOperation(operation);
    await operation;
  }

  private stopExternalSync(): void {
    if (this.externalSyncTimer !== undefined) {
      clearInterval(this.externalSyncTimer);
      this.externalSyncTimer = undefined;
    }
  }

  private assertCurrent(context: ThreadRepositoryContext): void {
    if (!this.isCurrent(context)) {
      throw new StaleThreadRepositoryContextError();
    }
  }

  private trackOperation(operation: Promise<unknown>): void {
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
  }

  private requireState(): BranchReviewState {
    if (this.state === undefined) {
      throw new Error("Thread repository has not been opened.");
    }

    return this.state;
  }
}

function requireThread(
  state: BranchReviewState,
  threadId: string,
): ReviewThread {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) {
    throw new Error(`Unknown review thread: ${threadId}`);
  }

  return thread;
}
