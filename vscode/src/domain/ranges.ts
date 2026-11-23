import type { SerializedPosition, SerializedRange } from "@revloop/shared";

export function comparePositions(
  left: SerializedPosition,
  right: SerializedPosition,
): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.character - right.character;
}

export function normalizeRange(range: SerializedRange): SerializedRange {
  if (comparePositions(range.start, range.end) <= 0) {
    return range;
  }

  return {
    start: range.end,
    end: range.start,
  };
}

export function rangeContainsLine(
  range: SerializedRange,
  line: number,
): boolean {
  const normalized = normalizeRange(range);
  return line >= normalized.start.line && line <= normalized.end.line;
}

export function rangesEqual(
  left: SerializedRange,
  right: SerializedRange,
): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}
