import { z } from "zod";
import { branchStateSchemaVersion } from "../domain/types.js";

const positionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});

const rangeSchema = z.object({
  start: positionSchema,
  end: positionSchema,
});

const repositoryIdentitySchema = z.object({
  key: z.string().min(1),
  rootPath: z.string().min(1),
  displayName: z.string().min(1),
  storageRoot: z.string().min(1).optional(),
});

const anchorSchema = z.object({
  filePath: z.string().min(1),
  range: rangeSchema,
  selectedText: z.string(),
  beforeContext: z.array(z.string()),
  afterContext: z.array(z.string()),
  contentHash: z.string().min(1),
  capturedAt: z.string().min(1),
});

const anchorHistorySchema = z.object({
  kind: z.enum(["created", "edited", "remapped", "outdated"]),
  at: z.string().min(1),
  fromRange: rangeSchema.optional(),
  toRange: rangeSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().min(1).optional(),
});

const diffContextSchema = z.object({
  header: z.string(),
  hunk: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
});

const reviewMessageSchema = z.object({
  id: z.string().min(1),
  author: z.enum(["user", "agent"]),
  body: z.string().min(1),
  createdAt: z.string().min(1),
  outcome: z.enum(["changed", "answered", "declined", "blocked"]).optional(),
});

const reviewThreadSchema = z.object({
  id: z.string().min(1),
  repositoryKey: z.string().min(1),
  branch: z.string().min(1),
  filePath: z.string().min(1),
  languageId: z.string().min(1),
  status: z.enum(["open", "outdated", "resolved"]),
  originalAnchor: anchorSchema,
  currentAnchor: anchorSchema.nullable(),
  anchorHistory: z.array(anchorHistorySchema),
  diffContext: diffContextSchema,
  messages: z.array(reviewMessageSchema).min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  resolvedAt: z.string().min(1).optional(),
});

export const branchReviewStateSchema = z.object({
  schemaVersion: z.literal(branchStateSchemaVersion),
  revision: z.number().int().nonnegative(),
  repository: repositoryIdentitySchema,
  branch: z.string().min(1),
  threads: z.array(reviewThreadSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
