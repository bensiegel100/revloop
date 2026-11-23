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
