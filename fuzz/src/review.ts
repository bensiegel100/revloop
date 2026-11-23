import * as fc from "fast-check";
import type {
  AgentReplyOutcome,
  AnchorHistoryEntry,
  AnchorSnapshot,
  DiffContext,
  ReviewMessage,
  ReviewThread,
  ReviewThreadStatus,
  SerializedRange,
} from "@revloop/shared";
import {
  nonEmptyTextArbitrary,
  repositoryRelativePathArbitrary,
  timestampArbitrary,
} from "./arbitraries.js";

interface MessageTemplate {
  readonly author: "user" | "agent";
  readonly body: string;
  readonly createdAt: string;
  readonly outcome?: AgentReplyOutcome;
}

export interface ReviewThreadArrayConstraints {
  readonly minLength?: number;
  readonly maxLength?: number;
}

const outcomeArbitrary = fc.constantFrom<AgentReplyOutcome>(
  "changed",
  "answered",
  "declined",
  "blocked",
);
const statusArbitrary = fc.constantFrom<ReviewThreadStatus>(
  "open",
  "outdated",
  "resolved",
);
const rangeArbitrary: fc.Arbitrary<SerializedRange> = fc
  .record({
    startLine: fc.nat({ max: 10_000 }),
    startCharacter: fc.nat({ max: 1_000 }),
    lineSpan: fc.nat({ max: 100 }),
    characterSpan: fc.nat({ max: 1_000 }),
    endCharacter: fc.nat({ max: 1_000 }),
  })
  .map(
    ({ startLine, startCharacter, lineSpan, characterSpan, endCharacter }) => ({
      start: {
        line: startLine,
        character: startCharacter,
      },
      end: {
        line: startLine + lineSpan,
        character:
          lineSpan === 0 ? startCharacter + characterSpan : endCharacter,
      },
    }),
  );
const diffContextArbitrary: fc.Arbitrary<DiffContext> = fc.record({
  header: fc.string({ maxLength: 80 }),
  hunk: fc.string({ maxLength: 300 }),
  oldStart: fc.nat({ max: 10_000 }),
  oldLines: fc.nat({ max: 1_000 }),
  newStart: fc.nat({ max: 10_000 }),
  newLines: fc.nat({ max: 1_000 }),
});
const userMessageTemplateArbitrary: fc.Arbitrary<MessageTemplate> = fc
  .tuple(nonEmptyTextArbitrary, timestampArbitrary)
  .map(([body, createdAt]) => ({
    author: "user",
    body,
    createdAt,
  }));
const agentMessageTemplateArbitrary: fc.Arbitrary<MessageTemplate> = fc
  .tuple(
    nonEmptyTextArbitrary,
    timestampArbitrary,
    fc.option(outcomeArbitrary, { nil: null }),
  )
  .map(([body, createdAt, outcome]) => ({
    author: "agent",
    body,
    createdAt,
    ...(outcome === null ? {} : { outcome }),
  }));
const messageTemplateArbitrary = fc.oneof(
  userMessageTemplateArbitrary,
  agentMessageTemplateArbitrary,
);

export function reviewThreadsArbitrary(
  repositoryKey: string,
  branch: string,
  constraints: ReviewThreadArrayConstraints = {},
): fc.Arbitrary<ReviewThread[]> {
  return fc.uniqueArray(reviewThreadArbitrary(repositoryKey, branch), {
    minLength: constraints.minLength ?? 0,
    maxLength: constraints.maxLength ?? 5,
    selector: (thread) => thread.id,
  });
}

export function reviewThreadArbitrary(
  repositoryKey: string,
  branch: string,
): fc.Arbitrary<ReviewThread> {
  return repositoryRelativePathArbitrary.chain((filePath) =>
    fc
      .record({
        id: fc.uuid(),
        languageId: fc.constantFrom(
          "typescript",
          "javascript",
          "json",
          "markdown",
          "plaintext",
        ),
        status: statusArbitrary,
        anchor: anchorArbitrary(filePath),
        diffContext: diffContextArbitrary,
        createdAt: timestampArbitrary,
        initialBody: nonEmptyTextArbitrary,
        additionalMessages: fc.array(messageTemplateArbitrary, {
          maxLength: 4,
        }),
      })
      .map(
        ({
          id,
          languageId,
          status,
          anchor,
          diffContext,
          createdAt,
          initialBody,
          additionalMessages,
        }) => {
          const anchorHistory: AnchorHistoryEntry[] = [
            {
              kind: "created",
              at: createdAt,
              toRange: anchor.range,
            },
          ];
          if (status === "outdated") {
            anchorHistory.push({
              kind: "outdated",
              at: createdAt,
              fromRange: anchor.range,
              reason: "Generated anchor could not be remapped.",
            });
          }

          const messages = [
            {
              author: "user" as const,
              body: initialBody,
              createdAt,
            },
            ...additionalMessages,
          ].map((message, index) => materializeMessage(id, index, message));

          return {
            id,
            repositoryKey,
            branch,
            filePath,
            languageId,
            status,
            originalAnchor: anchor,
            currentAnchor: status === "outdated" ? null : anchor,
            anchorHistory,
            diffContext,
            messages,
            createdAt,
            updatedAt: createdAt,
            ...(status === "resolved" ? { resolvedAt: createdAt } : {}),
          };
        },
      ),
  );
}

function anchorArbitrary(filePath: string): fc.Arbitrary<AnchorSnapshot> {
  return fc.record({
    filePath: fc.constant(filePath),
    range: rangeArbitrary,
    selectedText: fc.string({ maxLength: 160 }),
    beforeContext: fc.array(fc.string({ maxLength: 80 }), { maxLength: 4 }),
    afterContext: fc.array(fc.string({ maxLength: 80 }), { maxLength: 4 }),
    contentHash: fc.uuid(),
    capturedAt: timestampArbitrary,
  });
}

function materializeMessage(
  threadId: string,
  index: number,
  template: MessageTemplate,
): ReviewMessage {
  return {
    id: `${threadId}:message:${String(index)}`,
    author: template.author,
    body: template.body,
    createdAt: template.createdAt,
    ...(template.outcome === undefined ? {} : { outcome: template.outcome }),
  };
}
