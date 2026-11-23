import type { ReviewThread, SerializedRange } from "@revloop/shared";

export interface HistoricalDocument {
  content: string;
  range: SerializedRange;
}

export function buildHistoricalDocument(
  thread: ReviewThread,
): HistoricalDocument {
  let lines = extractModifiedLines(thread.diffContext.hunk);
  let sourceStartLine = Math.max(0, thread.diffContext.newStart - 1);

  if (lines.length === 0) {
    lines = [
      ...thread.originalAnchor.beforeContext,
      thread.originalAnchor.selectedText,
      ...thread.originalAnchor.afterContext,
    ];
    sourceStartLine = Math.max(
      0,
      thread.originalAnchor.range.start.line -
        thread.originalAnchor.beforeContext.length,
    );
  }

  if (lines.length === 0) {
    lines = [""];
  }

  const range = localizeRange(
    thread.originalAnchor.range,
    sourceStartLine,
    lines,
  );
  return {
    content: lines.join("\n"),
    range,
  };
}

function extractModifiedLines(hunk: string): string[] {
  return hunk
    .replaceAll("\r\n", "\n")
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("+") || line.startsWith(" "))
    .map((line) => line.slice(1));
}

function localizeRange(
  range: SerializedRange,
  sourceStartLine: number,
  lines: readonly string[],
): SerializedRange {
  const lastLine = Math.max(0, lines.length - 1);
  const startLine = clamp(range.start.line - sourceStartLine, 0, lastLine);
  const endLine = clamp(range.end.line - sourceStartLine, startLine, lastLine);
  const startCharacter = clamp(
    range.start.character,
    0,
    lines[startLine]?.length ?? 0,
  );
  const endCharacter = clamp(
    range.end.character,
    endLine === startLine ? startCharacter : 0,
    lines[endLine]?.length ?? 0,
  );

  return {
    start: {
      line: startLine,
      character: startCharacter,
    },
    end: {
      line: endLine,
      character: endCharacter,
    },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
