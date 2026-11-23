import type { CancellationToken, Disposable, Event, Uri } from "vscode";

export const enum RefType {
  Head,
  RemoteHead,
  Tag,
}

export const enum Status {
  IndexModified,
  IndexAdded,
  IndexDeleted,
  IndexRenamed,
  IndexCopied,
  Modified,
  Deleted,
  Untracked,
  Ignored,
  IntentToAdd,
  IntentToRename,
  TypeChanged,
}

export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface Branch extends Ref {
  readonly upstream?: {
    readonly remote: string;
    readonly name: string;
    readonly commit?: string;
  };
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly isReadOnly: boolean;
}

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: Status;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly refs: readonly Ref[];
  readonly remotes: readonly Remote[];
  readonly indexChanges: readonly Change[];
  readonly workingTreeChanges: readonly Change[];
  readonly untrackedChanges: readonly Change[];
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  readonly onDidCheckout: Event<void>;
  diffWithHEAD(): Promise<Change[]>;
  diffWithHEAD(path: string): Promise<string>;
  diffWith(ref: string): Promise<Change[]>;
  diffWith(ref: string, path: string): Promise<string>;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  getBranches(
    query: {
      readonly remote?: boolean;
      readonly pattern?: string | readonly string[];
    },
    cancellationToken?: CancellationToken,
  ): Promise<Ref[]>;
}

export interface GitApi {
  readonly state: "uninitialized" | "initialized";
  readonly onDidChangeState: Event<"uninitialized" | "initialized">;
  readonly git: {
    readonly path: string;
  };
  readonly repositories: readonly Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  toGitUri(uri: Uri, ref: string): Uri;
  getRepository(uri: Uri): Repository | null;
  openRepository(root: Uri): Promise<Repository | null>;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<void>;
  getAPI(version: 1): GitApi;
}

export interface DisposableGitContext extends Disposable {
  readonly api: GitApi;
}
