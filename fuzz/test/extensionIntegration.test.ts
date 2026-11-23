import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyGitRepositoryRecipe,
  createGitRepositoryFixture,
  fuzzParameters,
  nonBlankTextArbitrary,
} from "../src/index.js";
import type { GitRepositoryRecipe } from "../src/index.js";
import { JsonReviewStore } from "@revloop/shared";
import type {
  AgentReplyOutcome,
  DiffContext,
  ReviewThread,
} from "@revloop/shared";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { AnchorManager } from "../../vscode/src/anchors/anchorManager.js";
import type { ActiveRepository } from "../../vscode/src/git/gitService.js";
import { GitService } from "../../vscode/src/git/gitService.js";
import type { ReviewFile } from "../../vscode/src/git/types.js";
import { RefType } from "../../vscode/src/git/vscodeGitApi.js";
import type {
  Change,
  GitApi,
  Repository,
} from "../../vscode/src/git/vscodeGitApi.js";
import { ThreadRepository } from "../../vscode/src/storage/threadRepository.js";
import { McpReviewRepository } from "../../mcp/src/reviewRepository.js";

interface CommentAction {
  readonly fileIndex: number;
  readonly lineIndex: number;
  readonly body: string;
  readonly replyBody: string;
  readonly outcome?: AgentReplyOutcome;
}

interface ExtensionScenario {
  readonly actions: readonly CommentAction[];
}

const extensionRecipe: GitRepositoryRecipe = {
  changes: [
    { key: "modified", kind: "modified", payload: "modified payload" },
    { key: "added", kind: "added", payload: "added payload" },
    { key: "untracked", kind: "untracked", payload: "untracked payload" },
    { key: "renamed", kind: "renamed", payload: "renamed payload" },
  ],
};
const outcomeArbitrary = fc.constantFrom<AgentReplyOutcome>(
  "changed",
  "answered",
  "declined",
  "blocked",
);
const commentActionArbitrary: fc.Arbitrary<CommentAction> = fc
  .record({
    fileIndex: fc.nat(),
    lineIndex: fc.nat(),
    body: nonBlankTextArbitrary,
    replyBody: nonBlankTextArbitrary,
    outcome: fc.option(outcomeArbitrary, { nil: null }),
  })
  .map(({ fileIndex, lineIndex, body, replyBody, outcome }) => ({
    fileIndex,
    lineIndex,
    body,
    replyBody,
    ...(outcome === null ? {} : { outcome }),
  }));
const extensionScenarioArbitrary: fc.Arbitrary<ExtensionScenario> = fc
  .array(commentActionArbitrary, { minLength: 1, maxLength: 8 })
  .map((actions) => ({ actions }));

describe("extension integration fuzzing", () => {
  it("persists generated comments, agent replies, and edited anchors", async () => {
    const fixture = await createGitRepositoryFixture();
    try {
      const applied = await applyGitRepositoryRecipe(fixture, extensionRecipe);
      const documents = createDocuments();
      const git = new GitService(documents);
      const active = createActiveRepository(
        fixture.rootPath,
        fixture.branchName,
        fixture.branchRef,
        applied.baseRef,
        fixture.repository,
      );
      const snapshot = await git.buildSnapshot(active, {
        kind: "working-tree",
        baseCommit: applied.baseRef,
      });
      const commentableFiles = snapshot.files.filter((file) => file.canComment);
      const originalContents = new Map(
        await Promise.all(
          commentableFiles.map(
            async (file): Promise<readonly [string, string]> => [
              file.path,
              await readFile(
                path.join(fixture.rootPath, ...file.path.split("/")),
                "utf8",
              ),
            ],
          ),
        ),
      );
      expect(commentableFiles.length).toBeGreaterThan(0);
      expect(snapshot.files.map((file) => file.path).sort()).toEqual(
        [
          ...applied.trackedChanges.map((change) => change.path),
          ...applied.untrackedPaths,
        ].sort(),
      );

      await fc.assert(
        fc.asyncProperty(extensionScenarioArbitrary, async (scenario) => {
          await restoreContents(fixture.rootPath, originalContents);
          await fixture.resetReviewState();

          const threads = new ThreadRepository(new JsonReviewStore());
          const context = await threads.open(
            fixture.repository,
            fixture.branchRef,
          );
          if (context === undefined) {
            throw new Error("Unable to open the generated review state.");
          }
          const anchors = new AnchorManager(threads, () => 3);
          try {
            const created: {
              readonly action: CommentAction;
              readonly thread: ReviewThread;
            }[] = [];
            for (const action of scenario.actions) {
              const file =
                commentableFiles[action.fileIndex % commentableFiles.length];
              if (file === undefined) {
                throw new Error("No generated commentable file exists.");
              }
              const modifiedLines = file.diff.hunks.flatMap(
                (hunk) => hunk.modifiedLines,
              );
              const line =
                modifiedLines[action.lineIndex % modifiedLines.length];
              if (line === undefined) {
                throw new Error("No generated modified line exists.");
              }
              const content = await readFile(
                path.join(fixture.rootPath, ...file.path.split("/")),
                "utf8",
              );
              const textLine = content.split(/\r?\n/)[line] ?? "";
              const range = new vscode.Range(line, 0, line, textLine.length);
              const hunk = requireHunk(file, line);
              const thread = await threads.create({
                filePath: file.path,
                languageId: "plaintext",
                anchor: anchors.capture(
                  { getText: () => content },
                  file.path,
                  range,
                ),
                diffContext: toDiffContext(hunk),
                body: action.body,
              });
              created.push({ action, thread });
            }

            const mcp = await McpReviewRepository.fromWorkingDirectory(
              fixture.nestedPath,
            );
            const open = await mcp.readComments();
            expect(open.threads.map((thread) => thread.id)).toEqual(
              created.map(({ thread }) => thread.id),
            );
            expect(
              open.threads.map((thread) => thread.messages[0]?.body),
            ).toEqual(created.map(({ action }) => action.body.trim()));

            for (const { action, thread } of created) {
              const reply = await mcp.replyToComment(
                thread.id,
                action.replyBody,
                action.outcome,
              );
              expect(reply.thread.status).toBe("open");
            }

            const targetFile = created[0]?.thread.filePath;
            if (targetFile === undefined) {
              throw new Error("No generated comment thread exists.");
            }
            const targetPath = path.join(
              fixture.rootPath,
              ...targetFile.split("/"),
            );
            const beforeEdit = await readFile(targetPath, "utf8");
            await writeFile(
              targetPath,
              `inserted fuzz line\n${beforeEdit}`,
              "utf8",
            );
            setOpenTextDocumentFromDisk();
            await anchors.remapAll();

            const persisted = await mcp.readComments("all");
            for (const { action, thread } of created) {
              const current = persisted.threads.find(
                (candidate) => candidate.id === thread.id,
              );
              expect(current?.status).toBe("open");
              expect(current?.messages.at(-1)).toMatchObject({
                author: "agent",
                body: action.replyBody.trim(),
                ...(action.outcome === undefined
                  ? {}
                  : { outcome: action.outcome }),
              });
              expect(current?.currentAnchor?.range.start.line).toBe(
                thread.currentAnchor?.range.start.line === undefined
                  ? undefined
                  : thread.currentAnchor.range.start.line +
                      (thread.filePath === targetFile ? 1 : 0),
              );
            }
          } finally {
            anchors.dispose();
            threads.dispose();
          }
        }),
        fuzzParameters(),
      );
    } finally {
      await fixture.dispose();
    }
  }, 120_000);
});

function createActiveRepository(
  rootPath: string,
  branchName: string,
  branch: string,
  headCommit: string,
  identity: ActiveRepository["identity"],
): ActiveRepository {
  const repository = createRepository(rootPath, branchName, headCommit);
  return {
    api: createGitApi(repository),
    repository,
    identity,
    branchName,
    branch,
    headCommit,
  };
}

function createGitApi(repository: Repository): GitApi {
  return {
    state: "initialized",
    onDidChangeState: new vscode.EventEmitter<"uninitialized" | "initialized">()
      .event,
    git: { path: "git" },
    repositories: [repository],
    onDidOpenRepository: new vscode.EventEmitter<Repository>().event,
    onDidCloseRepository: new vscode.EventEmitter<Repository>().event,
    toGitUri: (uri, ref) =>
      vscode.Uri.from({ scheme: "git", path: uri.fsPath, query: ref }),
    getRepository: () => repository,
    openRepository: () => Promise.resolve(repository),
  };
}

function createRepository(
  rootPath: string,
  branchName: string,
  headCommit: string,
): Repository {
  return {
    rootUri: vscode.Uri.file(rootPath),
    state: {
      HEAD: {
        type: RefType.Head,
        name: branchName,
        commit: headCommit,
      },
      refs: [],
      remotes: [],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
      onDidChange: new vscode.EventEmitter<void>().event,
    },
    onDidCheckout: new vscode.EventEmitter<void>().event,
    diffWithHEAD,
    diffWith,
    getMergeBase: () => Promise.resolve(headCommit),
    getBranches: () => Promise.resolve([]),
  };
}

function diffWithHEAD(): Promise<Change[]>;
function diffWithHEAD(filePath: string): Promise<string>;
function diffWithHEAD(filePath?: string): Promise<Change[] | string> {
  return Promise.resolve(filePath === undefined ? [] : "");
}

function diffWith(reference: string): Promise<Change[]>;
function diffWith(reference: string, filePath: string): Promise<string>;
function diffWith(
  _reference: string,
  filePath?: string,
): Promise<Change[] | string> {
  return Promise.resolve(filePath === undefined ? [] : "");
}

function createDocuments(): {
  createEmptyUri(repositoryKey: string, filePath: string): vscode.Uri;
  createSnapshotUri(
    repositoryKey: string,
    filePath: string,
    content: string,
  ): vscode.Uri;
} {
  return {
    createEmptyUri: (repositoryKey, filePath) =>
      vscode.Uri.from({
        scheme: "revloop-empty",
        path: filePath,
        query: repositoryKey,
      }),
    createSnapshotUri: (repositoryKey, filePath, content) =>
      vscode.Uri.from({
        scheme: "revloop-snapshot",
        path: filePath,
        query: `${repositoryKey}:${content}`,
      }),
  };
}

function requireHunk(
  file: ReviewFile,
  line: number,
): ReviewFile["diff"]["hunks"][number] {
  const hunk = file.diff.hunks.find((candidate) =>
    candidate.modifiedLines.includes(line),
  );
  if (hunk === undefined) {
    throw new Error(`No diff hunk contains ${file.path}:${String(line + 1)}.`);
  }
  return hunk;
}

function toDiffContext(hunk: ReviewFile["diff"]["hunks"][number]): DiffContext {
  return {
    header: hunk.header,
    hunk: hunk.hunk,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
  };
}

async function restoreContents(
  rootPath: string,
  contents: ReadonlyMap<string, string>,
): Promise<void> {
  await Promise.all(
    [...contents].map(([filePath, content]) =>
      writeFile(path.join(rootPath, ...filePath.split("/")), content, "utf8"),
    ),
  );
}

function setOpenTextDocumentFromDisk(): void {
  Object.defineProperty(vscode.workspace, "openTextDocument", {
    configurable: true,
    value: async (uri: vscode.Uri) => {
      const content = await readFile(uri.fsPath, "utf8");
      return {
        getText: () => content,
      };
    },
  });
}
