import type * as vscode from "vscode";
import type {
  DiffContext,
  RepositoryIdentity,
  ReviewSource,
} from "@revloop/shared";

export type ReviewFileStatus =
  "modified" | "added" | "deleted" | "renamed" | "untracked" | "type-changed";

export interface ParsedDiffHunk extends DiffContext {
  modifiedLines: readonly number[];
}

export interface ParsedDiff {
  header: string;
  hunks: readonly ParsedDiffHunk[];
  binary: boolean;
}

export interface ReviewFile {
  path: string;
  originalPath?: string;
  status: ReviewFileStatus;
  baseUri: vscode.Uri;
  modifiedUri: vscode.Uri;
  diff: ParsedDiff;
  canComment: boolean;
}

export interface ReviewSnapshot {
  repository: RepositoryIdentity;
  branch: string;
  source: ReviewSource;
  files: readonly ReviewFile[];
  createdAt: string;
}
