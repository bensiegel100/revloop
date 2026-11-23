import type { ParsedDiff, ParsedDiffHunk } from "./types.js";

const hunkHeaderPattern =
  /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@/;

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const headerLines: string[] = [];
  const hunks: ParsedDiffHunk[] = [];
  let index = 0;

  while (index < lines.length && lines[index]?.startsWith("@@ ") !== true) {
    const line = lines[index];
    if (line !== undefined) {
      headerLines.push(line);
    }
    index += 1;
  }

  while (index < lines.length) {
    const header = lines[index];
    if (header?.startsWith("@@ ") !== true) {
      index += 1;
      continue;
    }

    const match = hunkHeaderPattern.exec(header);
    if (match?.groups === undefined) {
      throw new Error(`Unsupported unified diff hunk header: ${header}`);
    }

    const oldStart = Number(match.groups.oldStart);
    const oldLines = Number(match.groups.oldLines ?? "1");
    const newStart = Number(match.groups.newStart);
    const newLines = Number(match.groups.newLines ?? "1");
    const hunkLines = [header];
    const modifiedLines: number[] = [];
    let newLine = newStart;
    index += 1;

    while (index < lines.length) {
      const line = lines[index];
      if (
        line === undefined ||
        line.startsWith("@@ ") ||
        line.startsWith("diff --git ")
      ) {
        break;
      }

      hunkLines.push(line);
      if (line.startsWith("+")) {
        modifiedLines.push(Math.max(0, newLine - 1));
        newLine += 1;
      } else if (line.startsWith(" ")) {
        newLine += 1;
      }

      index += 1;
    }

    hunks.push({
      header: headerLines.join("\n"),
      hunk: hunkLines.join("\n"),
      oldStart,
      oldLines,
      newStart,
      newLines,
      modifiedLines,
    });
  }

  return {
    header: headerLines.join("\n"),
    hunks,
    binary: /(^|\n)(Binary files |GIT binary patch)/.test(diff),
  };
}

export function createUntrackedDiff(
  filePath: string,
  content: string,
  mode: "100644" | "100755" | "120000" = "100644",
): ParsedDiff {
  const normalized = content.replaceAll("\r\n", "\n");
  const contentLines = normalized.length === 0 ? [] : normalized.split("\n");
  if (contentLines.at(-1) === "") {
    contentLines.pop();
  }

  const body = contentLines.map((line) => `+${line}`);
  const lineCount = contentLines.length;
  const hunkHeader = `@@ -0,0 +1,${String(lineCount)} @@`;
  const diff = [
    `diff --git a/${filePath} b/${filePath}`,
    `new file mode ${mode}`,
    "--- /dev/null",
    `+++ b/${filePath}`,
    hunkHeader,
    ...body,
  ].join("\n");

  return parseUnifiedDiff(diff);
}

export function findHunkForLines(
  diff: ParsedDiff,
  startLine: number,
  endLine: number,
): ParsedDiffHunk | undefined {
  return diff.hunks.find((hunk) => {
    const hunkStart = Math.max(0, hunk.newStart - 1);
    const hunkEnd =
      hunk.newLines === 0 ? hunkStart : hunkStart + hunk.newLines - 1;
    return startLine <= hunkEnd && endLine >= hunkStart;
  });
}

export function toContiguousLineRanges(
  lines: readonly number[],
): readonly [number, number][] {
  const sorted = [...new Set(lines)].sort((left, right) => left - right);
  const ranges: [number, number][] = [];

  for (const line of sorted) {
    const previous = ranges.at(-1);
    if (previous !== undefined && line === previous[1] + 1) {
      previous[1] = line;
    } else {
      ranges.push([line, line]);
    }
  }

  return ranges;
}
