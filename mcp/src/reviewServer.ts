import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { normalizeRepositoryRelativePath } from "@revloop/shared";
import type { ReviewThread } from "@revloop/shared";
import { z } from "zod";
import { McpReviewRepository } from "./reviewRepository.js";

type ReviewRepository = Pick<
  McpReviewRepository,
  "readComments" | "replyToComment"
>;
type ReviewRepositoryFactory = (
  repositoryRoot: string,
) => Promise<ReviewRepository>;

const absoluteRepositoryRootSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), {
    message: "Repository root must be an absolute path.",
  });
const nonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Value must contain non-whitespace characters.",
  });
const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .refine(isRepositoryRelativePath, {
    message: "File path must be repository-relative.",
  });

export function createReviewServer(
  repositoryFactory: ReviewRepositoryFactory = (repositoryRoot) =>
    McpReviewRepository.fromWorkingDirectory(repositoryRoot),
): McpServer {
  const server = new McpServer({
    name: "revloop",
    version: "0.0.1",
  });
  const handlers = createReviewToolHandlers(
    createRepositoryResolver(repositoryFactory),
  );

  server.registerTool(
    "read_comments",
    {
      title: "Read Revloop comments",
      description:
        "Read Revloop review threads for the current repository and branch. Defaults to open threads only.",
      inputSchema: z.object({
        repositoryRoot: absoluteRepositoryRootSchema.describe(
          "Absolute path to the current Git repository root.",
        ),
        status: z
          .enum(["open", "outdated", "resolved", "unresolved", "all"])
          .optional()
          .describe(
            "Thread status to return. Unresolved includes open and outdated threads. Defaults to open.",
          ),
        filePath: repositoryRelativePathSchema
          .optional()
          .describe("Optional repository-relative file path filter."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    handlers.readComments,
  );

  server.registerTool(
    "reply_to_comment",
    {
      title: "Reply to a Revloop comment",
      description:
        "Append an agent reply describing what changed, answering the question, declining the request, or explaining a blocker. This tool never resolves or reopens the thread; only the user controls resolution.",
      inputSchema: z.object({
        repositoryRoot: absoluteRepositoryRootSchema.describe(
          "Absolute path to the current Git repository root.",
        ),
        threadId: nonBlankStringSchema.describe("Stable Revloop thread ID."),
        body: nonBlankStringSchema.describe("Detailed reply for the reviewer."),
        outcome: z
          .enum(["changed", "answered", "declined", "blocked"])
          .optional()
          .describe("Optional summary of how the comment was handled."),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
    },
    handlers.replyToComment,
  );

  return server;
}

export function createRepositoryResolver(
  repositoryFactory: ReviewRepositoryFactory,
): (repositoryRoot: string) => Promise<ReviewRepository> {
  const repositories = new Map<string, Promise<ReviewRepository>>();
  return (repositoryRoot) => {
    let repository = repositories.get(repositoryRoot);
    if (repository === undefined) {
      repository = repositoryFactory(repositoryRoot);
      repositories.set(repositoryRoot, repository);
    }
    return repository;
  };
}

export function createReviewToolHandlers(
  getRepository: (repositoryRoot: string) => Promise<ReviewRepository>,
): {
  readComments: (input: {
    repositoryRoot: string;
    status?:
      "open" | "outdated" | "resolved" | "unresolved" | "all" | undefined;
    filePath?: string | undefined;
  }) => Promise<{ content: [{ type: "text"; text: string }] }>;
  replyToComment: (input: {
    repositoryRoot: string;
    threadId: string;
    body: string;
    outcome?: "changed" | "answered" | "declined" | "blocked" | undefined;
  }) => Promise<{ content: [{ type: "text"; text: string }] }>;
} {
  return {
    readComments: async ({ repositoryRoot, status, filePath }) => {
      const repository = await getRepository(repositoryRoot);
      const result = await repository.readComments(status ?? "open", filePath);
      return textResult({
        repository: result.repository,
        branch: result.branch,
        count: result.threads.length,
        threads: result.threads.map(toAgentThread),
      });
    },
    replyToComment: async ({ repositoryRoot, threadId, body, outcome }) => {
      const repository = await getRepository(repositoryRoot);
      const result = await repository.replyToComment(threadId, body, outcome);
      return textResult({
        branch: result.branch,
        threadId: result.thread.id,
        replyId: result.replyId,
        status: result.thread.status,
      });
    },
  };
}

function isRepositoryRelativePath(value: string): boolean {
  try {
    normalizeRepositoryRelativePath(value);
    return true;
  } catch {
    return false;
  }
}

function toAgentThread(thread: ReviewThread): object {
  const anchor = thread.currentAnchor ?? thread.originalAnchor;
  return {
    id: thread.id,
    status: thread.status,
    filePath: thread.filePath,
    languageId: thread.languageId,
    currentRange: anchor.range,
    originalRange: thread.originalAnchor.range,
    selectedExcerpt: anchor.selectedText,
    diffContext: thread.diffContext,
    messages: thread.messages,
    anchorHistory: thread.anchorHistory,
  };
}

function textResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
