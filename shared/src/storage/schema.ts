import type {
  AnchorHistoryEntry,
  AnchorSnapshot,
  BranchReviewState,
  DiffContext,
  RepositoryIdentity,
  ReviewMessage,
  ReviewThread,
  SerializedPosition,
  SerializedRange,
} from "../domain/types.js";
import { branchStateSchemaVersion } from "../domain/types.js";

const anchorHistoryKinds = [
  "created",
  "edited",
  "remapped",
  "outdated",
] as const;
const reviewAuthors = ["user", "agent"] as const;
const reviewThreadStatuses = ["open", "outdated", "resolved"] as const;
const agentReplyOutcomes = [
  "changed",
  "answered",
  "declined",
  "blocked",
] as const;

type ValueParser<T> = (value: unknown, path: string) => T;

export function parseBranchReviewState(
  value: unknown,
  repository: RepositoryIdentity,
): BranchReviewState {
  const record = parseRecord(value, "review state");
  validateStoredRepository(record.repository, "review state.repository");

  return {
    schemaVersion: parseSchemaVersion(
      record.schemaVersion,
      "review state.schemaVersion",
    ),
    revision: parseNonnegativeInteger(record.revision, "review state.revision"),
    repository,
    branch: parseNonEmptyString(record.branch, "review state.branch"),
    threads: parseArray(
      record.threads,
      "review state.threads",
      parseReviewThread,
    ),
    createdAt: parseNonEmptyString(record.createdAt, "review state.createdAt"),
    updatedAt: parseNonEmptyString(record.updatedAt, "review state.updatedAt"),
  };
}

function validateStoredRepository(value: unknown, path: string): void {
  const record = parseRecord(value, path);
  parseNonEmptyString(record.key, `${path}.key`);
  parseNonEmptyString(record.rootPath, `${path}.rootPath`);
  parseNonEmptyString(record.displayName, `${path}.displayName`);
  parseOptional(record, "storageRoot", path, parseNonEmptyString);
}

function parseReviewThread(value: unknown, path: string): ReviewThread {
  const record = parseRecord(value, path);
  const resolvedAt = parseOptional(
    record,
    "resolvedAt",
    path,
    parseNonEmptyString,
  );
  const messages = parseArray(
    record.messages,
    `${path}.messages`,
    parseReviewMessage,
  );
  if (messages.length === 0) {
    invalid(`${path}.messages`);
  }

  const thread: ReviewThread = {
    id: parseNonEmptyString(record.id, `${path}.id`),
    repositoryKey: parseNonEmptyString(
      record.repositoryKey,
      `${path}.repositoryKey`,
    ),
    branch: parseNonEmptyString(record.branch, `${path}.branch`),
    filePath: parseNonEmptyString(record.filePath, `${path}.filePath`),
    languageId: parseNonEmptyString(record.languageId, `${path}.languageId`),
    status: parseEnum(record.status, reviewThreadStatuses, `${path}.status`),
    originalAnchor: parseAnchor(
      record.originalAnchor,
      `${path}.originalAnchor`,
    ),
    currentAnchor:
      record.currentAnchor === null
        ? null
        : parseAnchor(record.currentAnchor, `${path}.currentAnchor`),
    anchorHistory: parseArray(
      record.anchorHistory,
      `${path}.anchorHistory`,
      parseAnchorHistoryEntry,
    ),
    diffContext: parseDiffContext(record.diffContext, `${path}.diffContext`),
    messages,
    createdAt: parseNonEmptyString(record.createdAt, `${path}.createdAt`),
    updatedAt: parseNonEmptyString(record.updatedAt, `${path}.updatedAt`),
  };
  if (resolvedAt !== undefined) {
    thread.resolvedAt = resolvedAt;
  }
  return thread;
}

function parseAnchor(value: unknown, path: string): AnchorSnapshot {
  const record = parseRecord(value, path);
  return {
    filePath: parseNonEmptyString(record.filePath, `${path}.filePath`),
    range: parseRange(record.range, `${path}.range`),
    selectedText: parseString(record.selectedText, `${path}.selectedText`),
    beforeContext: parseArray(
      record.beforeContext,
      `${path}.beforeContext`,
      parseString,
    ),
    afterContext: parseArray(
      record.afterContext,
      `${path}.afterContext`,
      parseString,
    ),
    contentHash: parseNonEmptyString(record.contentHash, `${path}.contentHash`),
    capturedAt: parseNonEmptyString(record.capturedAt, `${path}.capturedAt`),
  };
}

function parseAnchorHistoryEntry(
  value: unknown,
  path: string,
): AnchorHistoryEntry {
  const record = parseRecord(value, path);
  const fromRange = parseOptional(record, "fromRange", path, parseRange);
  const toRange = parseOptional(record, "toRange", path, parseRange);
  const confidence = parseOptional(record, "confidence", path, parseConfidence);
  const reason = parseOptional(record, "reason", path, parseNonEmptyString);
  const entry: AnchorHistoryEntry = {
    kind: parseEnum(record.kind, anchorHistoryKinds, `${path}.kind`),
    at: parseNonEmptyString(record.at, `${path}.at`),
  };
  if (fromRange !== undefined) {
    entry.fromRange = fromRange;
  }
  if (toRange !== undefined) {
    entry.toRange = toRange;
  }
  if (confidence !== undefined) {
    entry.confidence = confidence;
  }
  if (reason !== undefined) {
    entry.reason = reason;
  }
  return entry;
}

function parseDiffContext(value: unknown, path: string): DiffContext {
  const record = parseRecord(value, path);
  return {
    header: parseString(record.header, `${path}.header`),
    hunk: parseString(record.hunk, `${path}.hunk`),
    oldStart: parseNonnegativeInteger(record.oldStart, `${path}.oldStart`),
    oldLines: parseNonnegativeInteger(record.oldLines, `${path}.oldLines`),
    newStart: parseNonnegativeInteger(record.newStart, `${path}.newStart`),
    newLines: parseNonnegativeInteger(record.newLines, `${path}.newLines`),
  };
}

function parseReviewMessage(value: unknown, path: string): ReviewMessage {
  const record = parseRecord(value, path);
  const outcome = parseOptional(
    record,
    "outcome",
    path,
    parseAgentReplyOutcome,
  );
  const message: ReviewMessage = {
    id: parseNonEmptyString(record.id, `${path}.id`),
    author: parseEnum(record.author, reviewAuthors, `${path}.author`),
    body: parseNonEmptyString(record.body, `${path}.body`),
    createdAt: parseNonEmptyString(record.createdAt, `${path}.createdAt`),
  };
  if (outcome !== undefined) {
    message.outcome = outcome;
  }
  return message;
}

function parseAgentReplyOutcome(
  value: unknown,
  path: string,
): ReviewMessage["outcome"] {
  return parseEnum(value, agentReplyOutcomes, path);
}

function parseRange(value: unknown, path: string): SerializedRange {
  const record = parseRecord(value, path);
  return {
    start: parsePosition(record.start, `${path}.start`),
    end: parsePosition(record.end, `${path}.end`),
  };
}

function parsePosition(value: unknown, path: string): SerializedPosition {
  const record = parseRecord(value, path);
  return {
    line: parseNonnegativeInteger(record.line, `${path}.line`),
    character: parseNonnegativeInteger(record.character, `${path}.character`),
  };
}

function parseRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalid(path);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArray<T>(
  value: unknown,
  path: string,
  parser: ValueParser<T>,
): T[] {
  if (!Array.isArray(value)) {
    return invalid(path);
  }
  return value.map((item, index) => parser(item, `${path}[${String(index)}]`));
}

function parseOptional<T>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  parser: ValueParser<T>,
): T | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const value = record[key];
  if (value === undefined) {
    return invalid(`${path}.${key}`);
  }
  return parser(value, `${path}.${key}`);
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return invalid(path);
  }
  return value;
}

function parseNonEmptyString(value: unknown, path: string): string {
  const parsed = parseString(value, path);
  if (parsed.length === 0) {
    return invalid(path);
  }
  return parsed;
}

function parseNonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(path);
  }
  return value;
}

function parseConfidence(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return invalid(path);
  }
  return value;
}

function parseSchemaVersion(
  value: unknown,
  path: string,
): typeof branchStateSchemaVersion {
  if (value !== branchStateSchemaVersion) {
    return invalid(path);
  }
  return value;
}

function parseEnum<const T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !isAllowedValue(value, allowedValues)) {
    return invalid(path);
  }
  return value;
}

function isAllowedValue<T extends string>(
  value: string,
  allowedValues: readonly T[],
): value is T {
  return allowedValues.some((allowedValue) => allowedValue === value);
}

function invalid(path: string): never {
  throw new TypeError(`Invalid review state at ${path}.`);
}
