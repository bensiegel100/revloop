import path from "node:path";
import * as fc from "fast-check";
import type { RepositoryIdentity } from "@revloop/shared";

export type RepositoryTemplate = Omit<RepositoryIdentity, "storageRoot">;

export const safePathSegmentArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/),
  fc.constantFrom("space name", "unicodé", "日本語", ".hidden"),
);

export const repositoryRelativePathArbitrary: fc.Arbitrary<string> = fc
  .array(safePathSegmentArbitrary, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("/"));

export const absoluteRepositoryRootArbitrary: fc.Arbitrary<string> = fc
  .array(safePathSegmentArbitrary, { minLength: 1, maxLength: 4 })
  .map((segments) =>
    path.resolve(path.parse(process.cwd()).root, "revloop-fuzz", ...segments),
  );

export const branchRefArbitrary: fc.Arbitrary<string> = fc
  .array(safePathSegmentArbitrary, { minLength: 1, maxLength: 4 })
  .map((segments) => `refs/heads/${segments.join("/")}`);

export const timestampArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 31_536_000_000 })
  .map((offset) => new Date(Date.UTC(2020, 0, 1) + offset).toISOString());

export const nonEmptyTextArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 256 }),
  fc.constantFrom(
    "line one\nline two",
    "emoji: 🐛",
    "tabs\tand spaces  ",
    "\u0000 embedded null",
    "combining: e\u0301",
  ),
);

export const nonBlankTextArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((value) => value.trim().length > 0),
  fc.constantFrom(
    "line one\nline two",
    "emoji: 🐛",
    "\u0000 embedded null",
    "combining: e\u0301",
  ),
);

export const repositoryTemplateArbitrary: fc.Arbitrary<RepositoryTemplate> =
  fc.record({
    key: fc.uuid(),
    rootPath: safePathSegmentArbitrary.map((name) => `/workspace/${name}`),
    displayName: safePathSegmentArbitrary,
  });
