export const branchStateSchemaVersion = 1;

export interface SerializedPosition {
  line: number;
  character: number;
}

export interface SerializedRange {
  start: SerializedPosition;
  end: SerializedPosition;
}

export interface RepositoryIdentity {
  key: string;
  rootPath: string;
  displayName: string;
  storageRoot: string;
}

export interface WorkingTreeReviewSource {
  kind: "working-tree";
  baseCommit: string;
}

export interface BranchReviewSource {
  kind: "branch";
  baseBranch: string;
  mergeBase: string;
}

export type ReviewSource = WorkingTreeReviewSource | BranchReviewSource;

export interface AnchorSnapshot {
  filePath: string;
  range: SerializedRange;
  selectedText: string;
  beforeContext: string[];
  afterContext: string[];
  contentHash: string;
  capturedAt: string;
}

export interface AnchorHistoryEntry {
  kind: "created" | "edited" | "remapped" | "outdated";
  at: string;
  fromRange?: SerializedRange;
  toRange?: SerializedRange;
  confidence?: number;
  reason?: string;
}

export interface DiffContext {
  header: string;
  hunk: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type ReviewThreadStatus = "open" | "outdated" | "resolved";
export type ReviewAuthor = "user" | "agent";
export type AgentReplyOutcome = "changed" | "answered" | "declined" | "blocked";

export interface ReviewMessage {
  id: string;
  author: ReviewAuthor;
  body: string;
  createdAt: string;
  outcome?: AgentReplyOutcome;
}

export interface ReviewThread {
  id: string;
  repositoryKey: string;
  branch: string;
  filePath: string;
  languageId: string;
  status: ReviewThreadStatus;
  originalAnchor: AnchorSnapshot;
  currentAnchor: AnchorSnapshot | null;
  anchorHistory: AnchorHistoryEntry[];
  diffContext: DiffContext;
  messages: ReviewMessage[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface BranchReviewState {
  schemaVersion: typeof branchStateSchemaVersion;
  revision: number;
  repository: RepositoryIdentity;
  branch: string;
  threads: ReviewThread[];
  createdAt: string;
  updatedAt: string;
}

export interface NewThreadInput {
  filePath: string;
  languageId: string;
  anchor: AnchorSnapshot;
  diffContext: DiffContext;
  body: string;
}
