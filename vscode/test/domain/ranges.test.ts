import { describe, expect, it } from "vitest";
import {
  comparePositions,
  normalizeRange,
  rangeContainsLine,
  rangesEqual,
} from "../../src/domain/ranges.js";

describe("serialized ranges", () => {
  it("orders positions by line and character", () => {
    expect(
      comparePositions({ line: 1, character: 9 }, { line: 2, character: 0 }),
    ).toBeLessThan(0);
    expect(
      comparePositions({ line: 2, character: 3 }, { line: 2, character: 1 }),
    ).toBeGreaterThan(0);
  });

  it("normalizes reversed ranges before containment checks", () => {
    const reversed = {
      start: { line: 5, character: 4 },
      end: { line: 2, character: 1 },
    };

    expect(normalizeRange(reversed)).toEqual({
      start: reversed.end,
      end: reversed.start,
    });
    expect(rangeContainsLine(reversed, 2)).toBe(true);
    expect(rangeContainsLine(reversed, 6)).toBe(false);
  });

  it("compares every range coordinate", () => {
    const range = {
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 },
    };

    expect(normalizeRange(range)).toBe(range);
    expect(rangesEqual(range, { ...range })).toBe(true);
    expect(
      rangesEqual(range, {
        ...range,
        end: { line: 3, character: 5 },
      }),
    ).toBe(false);
  });
});
