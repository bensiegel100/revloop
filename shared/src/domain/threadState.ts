import { randomUUID } from "node:crypto";
import type {
  AgentReplyOutcome,
  AnchorSnapshot,
  NewThreadInput,
  ReviewMessage,
  ReviewThread,
  SerializedRange,
} from "./types.js";

interface ThreadFactoryContext {
  repositoryKey: string;
  branch: string;
  now?: string;
  id?: string;
  messageId?: string;
}

export class ReviewMessageEditConflictError extends Error {
  public constructor(messageId: string) {
    super(`Review message changed before the edit was saved: ${messageId}`);
    this.name = "ReviewMessageEditConflictError";
  }
}

export function createReviewThread(
  input: NewThreadInput,
  context: ThreadFactoryContext,
): ReviewThread {
  const now = context.now ?? new Date().toISOString();
  const body = requireBody(input.body);

  return {
    id: context.id ?? randomUUID(),
    repositoryKey: context.repositoryKey,
    branch: context.branch,
    filePath: input.filePath,
    languageId: input.languageId,
    status: "open",
    originalAnchor: input.anchor,
    currentAnchor: input.anchor,
    anchorHistory: [
      {
        kind: "created",
        at: now,
        toRange: input.anchor.range,
      },
    ],
    diffContext: input.diffContext,
    messages: [
      {
        id: context.messageId ?? randomUUID(),
        author: "user",
        body,
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function appendUserMessage(
  thread: ReviewThread,
  body: string,
  now = new Date().toISOString(),
  messageId: string = randomUUID(),
): ReviewMessage {
  const message: ReviewMessage = {
    id: messageId,
    author: "user",
    body: requireBody(body),
    createdAt: now,
  };

  thread.messages.push(message);
  thread.updatedAt = now;
  return message;
}

export function editUserMessage(
  thread: ReviewThread,
  messageId: string,
  body: string,
  expectedBody: string,
  now = new Date().toISOString(),
): ReviewMessage {
  const message = thread.messages.find(
    (candidate) => candidate.id === messageId,
  );
  if (message === undefined) {
    throw new Error(`Unknown review message: ${messageId}`);
  }
  if (message.author !== "user") {
    throw new Error("Only user-authored review messages can be edited.");
  }

  const normalizedBody = requireBody(body);
  if (message.body !== requireBody(expectedBody)) {
    throw new ReviewMessageEditConflictError(messageId);
  }
  if (message.body === normalizedBody) {
    return message;
  }

  message.body = normalizedBody;
  thread.updatedAt = now;
  return message;
}

export function appendExternalAgentMessage(
  thread: ReviewThread,
  body: string,
  outcome?: AgentReplyOutcome,
  now = new Date().toISOString(),
  messageId: string = randomUUID(),
): ReviewMessage {
  const message: ReviewMessage = {
    id: messageId,
    author: "agent",
    body: requireBody(body),
    createdAt: now,
    ...(outcome === undefined ? {} : { outcome }),
  };

  thread.messages.push(message);
  thread.updatedAt = now;
  return message;
}

export function resolveThread(
  thread: ReviewThread,
  now = new Date().toISOString(),
): void {
  if (thread.status === "resolved") {
    return;
  }

  thread.status = "resolved";
  thread.resolvedAt = now;
  thread.updatedAt = now;
}

export function reopenThread(
  thread: ReviewThread,
  now = new Date().toISOString(),
): void {
  if (thread.status !== "resolved") {
    return;
  }

  thread.status = thread.currentAnchor === null ? "outdated" : "open";
  delete thread.resolvedAt;
  thread.updatedAt = now;
}

export function updateThreadAnchor(
  thread: ReviewThread,
  anchor: AnchorSnapshot,
  kind: "edited" | "remapped",
  confidence?: number,
  now = new Date().toISOString(),
): void {
  if (
    thread.currentAnchor !== null &&
    anchorsHaveSameLocationAndContext(thread.currentAnchor, anchor)
  ) {
    return;
  }

  const fromRange = thread.currentAnchor?.range;
  thread.currentAnchor = anchor;
  if (thread.status === "outdated") {
    thread.status = "open";
  }

  thread.anchorHistory.push({
    kind,
    at: now,
    ...(fromRange === undefined ? {} : { fromRange }),
    toRange: anchor.range,
    ...(confidence === undefined ? {} : { confidence }),
  });
  thread.updatedAt = now;
}

export function markThreadOutdated(
  thread: ReviewThread,
  reason: string,
  now = new Date().toISOString(),
): void {
  const normalizedReason = requireBody(reason);
  const latestEvent = thread.anchorHistory.at(-1);
  if (
    thread.currentAnchor === null &&
    thread.status === "outdated" &&
    latestEvent?.kind === "outdated" &&
    latestEvent.reason === normalizedReason
  ) {
    return;
  }

  const fromRange: SerializedRange | undefined = thread.currentAnchor?.range;
  thread.currentAnchor = null;
  if (thread.status !== "resolved") {
    thread.status = "outdated";
  }

  thread.anchorHistory.push({
    kind: "outdated",
    at: now,
    ...(fromRange === undefined ? {} : { fromRange }),
    reason: normalizedReason,
  });
  thread.updatedAt = now;
}

function requireBody(body: string): string {
  const normalized = body.trim();
  if (normalized.length === 0) {
    throw new Error("Review messages cannot be empty.");
  }

  return normalized;
}

function anchorsHaveSameLocationAndContext(
  left: AnchorSnapshot,
  right: AnchorSnapshot,
): boolean {
  return (
    left.filePath === right.filePath &&
    left.range.start.line === right.range.start.line &&
    left.range.start.character === right.range.start.character &&
    left.range.end.line === right.range.end.line &&
    left.range.end.character === right.range.end.character &&
    left.selectedText === right.selectedText &&
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
