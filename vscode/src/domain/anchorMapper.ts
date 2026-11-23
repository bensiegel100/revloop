import { sha256 } from "@revloop/shared";
import type {
  AnchorSnapshot,
  SerializedPosition,
  SerializedRange,
} from "@revloop/shared";

export interface AnchorMatch {
  anchor: AnchorSnapshot | null;
  confidence: number;
  reason?: string;
}

interface Candidate {
  range: SerializedRange;
  selectedText: string;
  score: number;
}

export function captureAnchor(
  filePath: string,
  text: string,
  range: SerializedRange,
  contextLines: number,
  capturedAt = new Date().toISOString(),
): AnchorSnapshot {
  const lines = splitLines(text);
  const normalizedRange = clampRange(range, lines);
  const selectedText = getTextInRange(lines, normalizedRange);

  return {
    filePath,
    range: normalizedRange,
    selectedText,
    beforeContext: lines.slice(
      Math.max(0, normalizedRange.start.line - contextLines),
      normalizedRange.start.line,
    ),
    afterContext: lines.slice(
      normalizedRange.end.line + 1,
      normalizedRange.end.line + 1 + contextLines,
    ),
    contentHash: sha256(text),
    capturedAt,
  };
}

export function remapAnchor(
  anchor: AnchorSnapshot,
  currentText: string,
  capturedAt = new Date().toISOString(),
): AnchorMatch {
  if (anchor.contentHash === sha256(currentText)) {
    return {
      anchor: {
        ...anchor,
        capturedAt,
      },
      confidence: 1,
    };
  }

  const normalizedText = normalizeLineEndings(currentText);
  const lines = normalizedText.split("\n");
  const exactCandidates = findExactCandidates(anchor, normalizedText, lines);
  const candidates =
    exactCandidates.length > 0
      ? exactCandidates
      : findFuzzyCandidates(anchor, lines);

  if (candidates.length === 0) {
    return {
      anchor: null,
      confidence: 0,
      reason: "The selected code no longer has a confident match.",
    };
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (best === undefined) {
    return {
      anchor: null,
      confidence: 0,
      reason: "The selected code no longer has a confident match.",
    };
  }

  const second = candidates[1];
  const ambiguityGap = second === undefined ? 1 : best.score - second.score;
  if (best.score < 0.72 || ambiguityGap < 0.1) {
    return {
      anchor: null,
      confidence: best.score,
      reason:
        ambiguityGap < 0.1
          ? "Multiple locations match the original code."
          : "The best code match is below the confidence threshold.",
    };
  }

  return {
    anchor: captureAnchor(
      anchor.filePath,
      currentText,
      best.range,
      Math.max(anchor.beforeContext.length, anchor.afterContext.length),
      capturedAt,
    ),
    confidence: Math.min(1, best.score),
  };
}

function findExactCandidates(
  anchor: AnchorSnapshot,
  text: string,
  lines: readonly string[],
): Candidate[] {
  if (anchor.selectedText.length === 0) {
    return [];
  }

  const lineOffsets = getLineOffsets(text);
  const candidates: Candidate[] = [];
  let offset = text.indexOf(anchor.selectedText);

  while (offset >= 0) {
    const start = offsetToPosition(offset, lineOffsets);
    const end = offsetToPosition(
      offset + anchor.selectedText.length,
      lineOffsets,
    );
    const range = clampRange({ start, end }, lines);
    candidates.push({
      range,
      selectedText: anchor.selectedText,
      score: scoreCandidate(anchor, lines, range, anchor.selectedText, true),
    });
    offset = text.indexOf(anchor.selectedText, offset + 1);
  }

  return candidates;
}

function findFuzzyCandidates(
  anchor: AnchorSnapshot,
  lines: readonly string[],
): Candidate[] {
  const selectedLineCount = Math.max(
    1,
    anchor.range.end.line - anchor.range.start.line + 1,
  );
  const candidates: Candidate[] = [];

  for (let startLine = 0; startLine < lines.length; startLine += 1) {
    const endLine = Math.min(
      lines.length - 1,
      startLine + selectedLineCount - 1,
    );
    const startCharacter = Math.min(
      anchor.range.start.character,
      lines[startLine]?.length ?? 0,
    );
    const endCharacter = findBestEndCharacter(
      anchor,
      lines,
      startLine,
      endLine,
      startCharacter,
    );
    const range: SerializedRange = {
      start: {
        line: startLine,
        character: startCharacter,
      },
      end: {
        line: endLine,
        character: endCharacter,
      },
    };
    const selectedText = getTextInRange(lines, range);
    const score = scoreCandidate(anchor, lines, range, selectedText, false);
    if (score >= 0.45) {
      candidates.push({ range, selectedText, score });
    }
  }

  return candidates;
}

function findBestEndCharacter(
  anchor: AnchorSnapshot,
  lines: readonly string[],
  startLine: number,
  endLine: number,
  startCharacter: number,
): number {
  const lineLength = lines[endLine]?.length ?? 0;
  const minimum = endLine === startLine ? startCharacter : 0;
  const preferred = Math.min(
    Math.max(minimum, anchor.range.end.character),
    lineLength,
  );
  if (anchor.selectedText.length === 0) {
    return preferred;
  }

  let bestCharacter = preferred;
  let bestSimilarity = -1;
  let bestLengthDistance = Number.POSITIVE_INFINITY;
  for (
    let endCharacter = minimum;
    endCharacter <= lineLength;
    endCharacter += 1
  ) {
    const selectedText = getTextInRange(lines, {
      start: {
        line: startLine,
        character: startCharacter,
      },
      end: {
        line: endLine,
        character: endCharacter,
      },
    });
    const similarity = diceCoefficient(
      normalizeCode(anchor.selectedText),
      normalizeCode(selectedText),
    );
    const lengthDistance = Math.abs(
      selectedText.length - anchor.selectedText.length,
    );
    if (
      similarity > bestSimilarity ||
      (similarity === bestSimilarity && lengthDistance < bestLengthDistance)
    ) {
      bestCharacter = endCharacter;
      bestSimilarity = similarity;
      bestLengthDistance = lengthDistance;
    }
  }

  return bestCharacter;
}

function scoreCandidate(
  anchor: AnchorSnapshot,
  lines: readonly string[],
  range: SerializedRange,
  selectedText: string,
  exact: boolean,
): number {
  const selectionScore = exact
    ? 1
    : diceCoefficient(
        normalizeCode(anchor.selectedText),
        normalizeCode(selectedText),
      );
  const before = lines.slice(
    Math.max(0, range.start.line - anchor.beforeContext.length),
    range.start.line,
  );
  const after = lines.slice(
    range.end.line + 1,
    range.end.line + 1 + anchor.afterContext.length,
  );
  const beforeScore = contextSimilarity(anchor.beforeContext, before, true);
  const afterScore = contextSimilarity(anchor.afterContext, after, false);
  const distance = Math.abs(range.start.line - anchor.range.start.line);
  const proximityScore = 1 / (1 + distance / 20);

  return (
    selectionScore * 0.65 +
    beforeScore * 0.15 +
    afterScore * 0.15 +
    proximityScore * 0.05
  );
}

function contextSimilarity(
  expected: readonly string[],
  actual: readonly string[],
  alignEnd: boolean,
): number {
  if (expected.length === 0) {
    return 1;
  }

  const length = Math.min(expected.length, actual.length);
  if (length === 0) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const expectedIndex = alignEnd ? expected.length - length + index : index;
    const actualIndex = alignEnd ? actual.length - length + index : index;
    total += diceCoefficient(
      normalizeCode(expected[expectedIndex] ?? ""),
      normalizeCode(actual[actualIndex] ?? ""),
    );
  }

  return total / expected.length;
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) {
    return 1;
  }
  if (left.length < 2 || right.length < 2) {
    return 0;
  }

  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  let overlap = 0;
  const remaining = new Map<string, number>();
  for (const pair of rightPairs) {
    remaining.set(pair, (remaining.get(pair) ?? 0) + 1);
  }
  for (const pair of leftPairs) {
    const count = remaining.get(pair) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(pair, count - 1);
    }
  }

  return (2 * overlap) / (leftPairs.length + rightPairs.length);
}

function bigrams(value: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

function normalizeCode(value: string): string {
  return value.replace(/\s+/g, "").toLocaleLowerCase();
}

function splitLines(text: string): string[] {
  return normalizeLineEndings(text).split("\n");
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function clampRange(
  range: SerializedRange,
  lines: readonly string[],
): SerializedRange {
  const lastLine = Math.max(0, lines.length - 1);
  const startLine = Math.min(Math.max(0, range.start.line), lastLine);
  const endLine = Math.min(Math.max(startLine, range.end.line), lastLine);
  const startCharacter = Math.min(
    Math.max(0, range.start.character),
    lines[startLine]?.length ?? 0,
  );
  const endCharacter = Math.min(
    Math.max(endLine === startLine ? startCharacter : 0, range.end.character),
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

function getTextInRange(
  lines: readonly string[],
  range: SerializedRange,
): string {
  if (range.start.line === range.end.line) {
    return (lines[range.start.line] ?? "").slice(
      range.start.character,
      range.end.character,
    );
  }

  const selected: string[] = [];
  selected.push((lines[range.start.line] ?? "").slice(range.start.character));
  for (let line = range.start.line + 1; line < range.end.line; line += 1) {
    selected.push(lines[line] ?? "");
  }
  selected.push((lines[range.end.line] ?? "").slice(0, range.end.character));
  return selected.join("\n");
}

function getLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetToPosition(
  offset: number,
  lineOffsets: readonly number[],
): SerializedPosition {
  let low = 0;
  let high = lineOffsets.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineOffset = lineOffsets[middle] ?? 0;
    const nextOffset = lineOffsets[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < lineOffset) {
      high = middle - 1;
    } else if (offset >= nextOffset) {
      low = middle + 1;
    } else {
      return {
        line: middle,
        character: offset - lineOffset,
      };
    }
  }

  const line = Math.max(0, lineOffsets.length - 1);
  return {
    line,
    character: offset - (lineOffsets[line] ?? 0),
  };
}
