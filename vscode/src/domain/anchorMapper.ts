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

const minimumMatchScore = 0.72;
const minimumContextBackedMatchScore = 0.55;
const strongContextScore = 0.9;
const minimumAmbiguityGap = 0.1;
const minimumContextGap = 0.1;
const maxFuzzyCandidateEvaluations = 2_000;

interface Candidate {
  range: SerializedRange;
  selectedText: string;
  score: number;
  contextScore: number;
  contextEvidence: number;
  exact: boolean;
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
  const normalizedSelectedText = normalizeCode(anchor.selectedText);
  const exactCandidates = findExactCandidates(
    anchor,
    normalizedText,
    lines,
    normalizedSelectedText,
  );
  const oldRange = clampRange(anchor.range, lines);
  const oldRangeCandidate = exactCandidates.find((candidate) =>
    rangesEqual(candidate.range, oldRange),
  );
  if (
    oldRangeCandidate !== undefined &&
    (exactCandidates.length === 1 ||
      (oldRangeCandidate.contextEvidence > 0 &&
        !exactCandidates.some(
          (candidate) =>
            candidate !== oldRangeCandidate &&
            candidate.contextScore > oldRangeCandidate.contextScore,
        )))
  ) {
    return {
      anchor: captureAnchor(
        anchor.filePath,
        currentText,
        oldRangeCandidate.range,
        Math.max(anchor.beforeContext.length, anchor.afterContext.length),
        capturedAt,
      ),
      confidence: 1,
    };
  }
  const candidates =
    exactCandidates.length > 0
      ? exactCandidates
      : findFuzzyCandidates(anchor, lines, normalizedSelectedText);

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

  const second = candidates.find(
    (candidate) =>
      candidate !== best &&
      !rangesEqual(candidate.range, best.range) &&
      (best.exact || !rangesOverlap(candidate.range, best.range)),
  );
  const ambiguityGap = second === undefined ? 1 : best.score - second.score;
  const contextGap =
    second === undefined ? 1 : best.contextScore - second.contextScore;
  const contextConfirmed =
    best.contextEvidence > 0 &&
    best.contextScore === 1 &&
    (second === undefined || second.contextScore < 1);
  const ambiguous =
    !contextConfirmed &&
    ambiguityGap < minimumAmbiguityGap &&
    contextGap < minimumContextGap;
  const belowConfidenceThreshold =
    best.score < minimumMatchScore &&
    !(
      best.score >= minimumContextBackedMatchScore &&
      best.contextEvidence > 0 &&
      best.contextScore >= strongContextScore
    );
  if (belowConfidenceThreshold || ambiguous) {
    return {
      anchor: null,
      confidence: best.score,
      reason: ambiguous
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
  normalizedSelectedText: string,
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
    const candidateScore = scoreCandidate(
      anchor,
      lines,
      range,
      anchor.selectedText,
      true,
      normalizedSelectedText,
    );
    candidates.push({
      range,
      selectedText: anchor.selectedText,
      ...candidateScore,
      exact: true,
    });
    offset = text.indexOf(anchor.selectedText, offset + 1);
  }

  return candidates;
}

function findFuzzyCandidates(
  anchor: AnchorSnapshot,
  lines: readonly string[],
  normalizedSelectedText: string,
): Candidate[] {
  const selectedLineCount = Math.max(
    1,
    anchor.range.end.line - anchor.range.start.line + 1,
  );
  const lineCountDelta = Math.max(
    4,
    anchor.beforeContext.length,
    anchor.afterContext.length,
  );
  const minimumLineCount = Math.max(1, selectedLineCount - lineCountDelta);
  const maximumLineCount = selectedLineCount + lineCountDelta;
  const candidates: Candidate[] = [];
  let evaluations = 0;

  for (const startLine of startLinesByProximity(
    lines.length,
    anchor.range.start.line,
  )) {
    const availableLineCount = lines.length - startLine;
    const candidateMaximumLineCount = Math.min(
      maximumLineCount,
      availableLineCount,
    );

    let bestForStart: Candidate | undefined;
    for (
      let lineCount = minimumLineCount;
      lineCount <= candidateMaximumLineCount;
      lineCount += 1
    ) {
      if (evaluations >= maxFuzzyCandidateEvaluations) {
        return candidates;
      }
      evaluations += 1;
      const endLine = startLine + lineCount - 1;
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
        normalizedSelectedText,
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
      const candidateScore = scoreCandidate(
        anchor,
        lines,
        range,
        selectedText,
        false,
        normalizedSelectedText,
      );
      if (candidateScore.score >= 0.45) {
        const candidate = {
          range,
          selectedText,
          ...candidateScore,
          exact: false,
        };
        if (
          bestForStart === undefined ||
          candidate.score > bestForStart.score
        ) {
          bestForStart = candidate;
        }
      }
    }
    if (bestForStart !== undefined) {
      if (
        bestForStart.contextEvidence > 0 &&
        bestForStart.contextScore === 1 &&
        bestForStart.score >= minimumContextBackedMatchScore
      ) {
        return [bestForStart];
      }
      candidates.push(bestForStart);
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
  normalizedSelectedText: string,
): number {
  const lineLength = lines[endLine]?.length ?? 0;
  const minimum = endLine === startLine ? startCharacter : 0;
  const preferred = Math.min(
    Math.max(minimum, anchor.range.end.character),
    lineLength,
  );
  const candidateCharacters = new Set([minimum, preferred, lineLength]);
  if (startLine === endLine) {
    candidateCharacters.add(
      Math.min(lineLength, startCharacter + anchor.selectedText.length),
    );
  }
  const selectedLines = splitLines(anchor.selectedText);
  const selectedSuffix = (selectedLines.at(-1) ?? "").slice(-3);
  if (selectedSuffix.length > 0) {
    const endLineText = lines[endLine] ?? "";
    let suffixOffset = endLineText.indexOf(selectedSuffix);
    while (suffixOffset >= 0) {
      candidateCharacters.add(suffixOffset + selectedSuffix.length);
      suffixOffset = endLineText.indexOf(selectedSuffix, suffixOffset + 1);
    }
  }
  let bestCharacter = preferred;
  let bestSimilarity = -1;
  let bestLengthDistance = Number.POSITIVE_INFINITY;
  for (const endCharacter of candidateCharacters) {
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
      normalizedSelectedText,
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
  normalizedSelectedText: string,
): { score: number; contextScore: number; contextEvidence: number } {
  const selectionScore = exact
    ? 1
    : diceCoefficient(normalizedSelectedText, normalizeCode(selectedText));
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
  let weightedScore = selectionScore * 0.65 + proximityScore * 0.05;
  let totalWeight = 0.7;
  let contextScore = 0;
  let contextEvidence = 0;
  if (anchor.beforeContext.length > 0) {
    weightedScore += beforeScore * 0.15;
    totalWeight += 0.15;
    contextScore += beforeScore;
    contextEvidence += 1;
  }
  if (anchor.afterContext.length > 0) {
    weightedScore += afterScore * 0.15;
    totalWeight += 0.15;
    contextScore += afterScore;
    contextEvidence += 1;
  }

  return {
    score: weightedScore / totalWeight,
    contextScore: contextEvidence === 0 ? 0 : contextScore / contextEvidence,
    contextEvidence,
  };
}

function rangesEqual(left: SerializedRange, right: SerializedRange): boolean {
  return (
    comparePositions(left.start, right.start) === 0 &&
    comparePositions(left.end, right.end) === 0
  );
}

function rangesOverlap(left: SerializedRange, right: SerializedRange): boolean {
  return (
    comparePositions(left.start, right.end) < 0 &&
    comparePositions(right.start, left.end) < 0
  );
}

function startLinesByProximity(
  lineCount: number,
  preferredLine: number,
): number[] {
  const result: number[] = [];
  const clampedPreferred = Math.min(
    Math.max(0, preferredLine),
    Math.max(0, lineCount - 1),
  );
  for (let distance = 0; result.length < lineCount; distance += 1) {
    const before = clampedPreferred - distance;
    const after = clampedPreferred + distance;
    if (before >= 0) {
      result.push(before);
    }
    if (distance > 0 && after < lineCount) {
      result.push(after);
    }
  }
  return result;
}

function comparePositions(
  left: SerializedPosition,
  right: SerializedPosition,
): number {
  return left.line === right.line
    ? left.character - right.character
    : left.line - right.line;
}

function contextSimilarity(
  expected: readonly string[],
  actual: readonly string[],
  alignEnd: boolean,
): number {
  if (expected.length === 0) {
    return 0;
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
