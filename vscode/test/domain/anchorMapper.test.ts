import { describe, expect, it } from "vitest";
import { captureAnchor, remapAnchor } from "../../src/domain/anchorMapper.js";

describe("anchor mapper", () => {
  it("tracks exact code after lines are inserted above it", () => {
    const original = ["alpha", "target();", "omega"].join("\n");
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 9 },
      },
      2,
      "2026-01-01T00:00:00.000Z",
    );

    const match = remapAnchor(
      anchor,
      ["inserted", "alpha", "target();", "omega"].join("\n"),
    );

    expect(match.anchor?.range.start.line).toBe(2);
    expect(match.confidence).toBeGreaterThan(0.9);
  });

  it("tracks a small edit within selected code", () => {
    const original = ["function run() {", "  return oldName + 1;", "}"].join(
      "\n",
    );
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 21 },
      },
      2,
    );

    const match = remapAnchor(
      anchor,
      ["function run() {", "  return newName + 1;", "}"].join("\n"),
    );

    expect(match.anchor).not.toBeNull();
    expect(match.anchor?.range.start.line).toBe(1);
    expect(match.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("exactly remaps multiline selections in CRLF documents", () => {
    const original = ["before", "first", "second", "after"].join("\r\n");
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 6 },
      },
      2,
    );

    const match = remapAnchor(
      anchor,
      ["inserted", "before", "first", "second", "after"].join("\r\n"),
    );

    expect(match.anchor?.range).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 3, character: 6 },
    });
    expect(match.anchor?.selectedText).toBe("first\nsecond");
    expect(match.confidence).toBeGreaterThan(0.9);
  });

  it("updates the selection end when edited code changes length", () => {
    const original = ["function run() {", "  return oldName + 1;", "}"].join(
      "\n",
    );
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 21 },
      },
      2,
    );
    const changedLine = "  return muchLongerName + 1;";

    const match = remapAnchor(
      anchor,
      ["function run() {", changedLine, "}"].join("\n"),
    );

    expect(match.anchor?.selectedText).toBe(changedLine.slice(2));
    expect(match.anchor?.range.end.character).toBe(changedLine.length);
  });

  it("keeps an exact selection at its current range when duplicates exist", () => {
    const original = [
      "first();",
      "before();",
      "target();",
      "after();",
      "last();",
    ].join("\n");
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 9 },
      },
      1,
    );

    const match = remapAnchor(
      anchor,
      ["target();", "before();", "target();", "after();", "target();"].join(
        "\n",
      ),
    );

    expect(match.anchor?.range).toEqual(anchor.range);
    expect(match.confidence).toBe(1);
  });

  it("moves empty-line anchors using their surrounding context", () => {
    const original = ["header();", "", "footer();"].join("\n");
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
      },
      1,
    );

    const match = remapAnchor(
      anchor,
      ["inserted();", "header();", "", "footer();"].join("\n"),
    );

    expect(match.anchor?.range).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 2, character: 0 },
    });
  });

  it("prefers matching context over duplicate text at the old range", () => {
    const original = ["alpha();", "  return null;", "omega();"].join("\n");
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 14 },
      },
      1,
    );

    const match = remapAnchor(
      anchor,
      [
        "if (guard) {",
        "  return null;",
        "}",
        "alpha();",
        "  return null;",
        "omega();",
      ].join("\n"),
    );

    expect(match.anchor?.range.start.line).toBe(4);
  });

  it("keeps a repeated token at its old column after an unrelated edit", () => {
    const line = "return left.start.line === right.start.line;";
    const startCharacter = line.indexOf("start");
    const anchor = captureAnchor(
      "src/example.ts",
      ["before();", line, "after();"].join("\n"),
      {
        start: { line: 1, character: startCharacter },
        end: { line: 1, character: startCharacter + "start".length },
      },
      3,
    );

    const match = remapAnchor(
      anchor,
      ["before();", line, "after();", "unrelated();"].join("\n"),
    );

    expect(match.anchor?.range).toEqual(anchor.range);
    expect(match.confidence).toBe(1);
  });

  it("keeps a unique exact old-range match without context", () => {
    const anchor = captureAnchor(
      "src/example.ts",
      "target();",
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 9 },
      },
      0,
    );

    const match = remapAnchor(anchor, "target();\nunrelated();");

    expect(match.anchor?.range).toEqual(anchor.range);
    expect(match.confidence).toBe(1);
  });

  it("rejects unrelated replacements without captured context", () => {
    const anchor = captureAnchor(
      "src/example.ts",
      "export default 1;",
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 17 },
      },
      0,
    );

    const match = remapAnchor(anchor, 'import os from "node:os";');

    expect(match.anchor).toBeNull();
  });

  it("tracks a multiline replacement with a different line count", () => {
    const original = [
      "export interface PersistenceScenario {",
      "  readonly branch: string;",
      "  readonly snapshots: readonly string[];",
      "}",
      "",
      "export interface BranchIsolationScenario {",
      "  readonly repository: RepositoryTemplate;",
      "  readonly first: {",
      "    readonly branch: string;",
      "    readonly threads: readonly ReviewThread[];",
      "  };",
      "  readonly second: {",
      "    readonly branch: string;",
      "    readonly threads: readonly ReviewThread[];",
      "  };",
      "}",
      "interface MessageTemplate {}",
    ].join("\n");
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 7, character: 0 },
        end: { line: 14, character: 4 },
      },
      2,
    );

    const match = remapAnchor(
      anchor,
      [
        "export interface PersistenceScenario {",
        "  readonly branch: string;",
        "  readonly snapshots: readonly string[];",
        "  readonly legacyState: {",
        "    readonly revision: number;",
        "    readonly createdAt: string;",
        "    readonly updatedAt: string;",
        "  };",
        "}",
        "",
        "export interface BranchIsolationScenario {",
        "  readonly repository: RepositoryTemplate;",
        "  readonly branches: readonly {",
        "    readonly branch: string;",
        "    readonly threads: readonly ReviewThread[];",
        "  }[];",
        "}",
        "interface MessageTemplate {}",
      ].join("\n"),
    );

    expect(match.anchor?.range).toEqual({
      start: { line: 12, character: 0 },
      end: { line: 15, character: 6 },
    });
    expect(match.anchor?.selectedText).toContain("readonly branches");
    expect(match.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it("tracks edited multiline selections at the start of a file", () => {
    const original = [
      'import { logger } from "./logging.js";',
      'import { parse } from "./parse.js";',
      "const value = logger(parse());",
      "export { value };",
      "after();",
    ].join("\n");
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 0, character: 0 },
        end: { line: 3, character: "export { value };".length },
      },
      2,
    );

    const match = remapAnchor(
      anchor,
      [
        'import { createLogger } from "./logging.js";',
        'import { parse } from "./parse.js";',
        "const value = createLogger()(parse());",
        "export { value };",
        "after();",
      ].join("\n"),
    );

    expect(match.anchor?.range.start.line).toBe(0);
    expect(match.anchor?.range.end.line).toBe(3);
  });

  it("marks overlapping exact occurrences as ambiguous", () => {
    const anchor = captureAnchor(
      "src/example.ts",
      ["before", "run();", "run();", "after"].join("\n"),
      {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 6 },
      },
      0,
    );

    const match = remapAnchor(
      anchor,
      ["before", "run();", "run();", "run();", "after"].join("\n"),
    );

    expect(match.anchor).toBeNull();
    expect(match.reason).toMatch(/Multiple locations/);
  });

  it("bounds fuzzy remapping work for large edited selections", () => {
    const lines = Array.from(
      { length: 5_000 },
      (_, index) =>
        `line ${String(index)} ${"generated realistic source content ".repeat(2)}`,
    );
    const startLine = 2_500;
    const anchor = captureAnchor(
      "src/example.ts",
      lines.join("\n"),
      {
        start: { line: startLine, character: 0 },
        end: {
          line: startLine + 39,
          character: lines[startLine + 39]?.length ?? 0,
        },
      },
      3,
    );
    lines[startLine + 20] = "edited realistic source content";

    const startedAt = performance.now();
    const match = remapAnchor(anchor, lines.join("\n"));
    const duration = performance.now() - startedAt;

    expect(match.anchor).not.toBeNull();
    expect(duration).toBeLessThan(3_000);
  });

  it("marks indistinguishable duplicate matches as ambiguous", () => {
    const original = ["before", "target();", "after"].join("\n");
    const anchor = captureAnchor(
      "src/example.ts",
      original,
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 9 },
      },
      0,
    );

    const match = remapAnchor(
      anchor,
      ["target();", "spacer", "target();"].join("\n"),
    );

    expect(match.anchor).toBeNull();
    expect(match.reason).toMatch(/Multiple locations/);
  });
});
