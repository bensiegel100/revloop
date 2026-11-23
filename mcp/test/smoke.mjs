import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const packageRoot = process.cwd();
const repositoryRoot = await mkdtemp(
  path.join(os.tmpdir(), "revloop-mcp-smoke-"),
);
const pluginRoot = await mkdtemp(path.join(os.tmpdir(), "revloop-plugin-"));

try {
  await initializeRepository(repositoryRoot);
  const commonDirectory = path.join(repositoryRoot, ".git");
  const storageRoot = path.join(commonDirectory, "revloop");
  const repositoryKey = sha256(`${commonDirectory}\0`);
  const branch = "refs/heads/main";
  const branchFile = path.join(
    storageRoot,
    "branches",
    `${sha256(branch)}.json`,
  );
  await mkdir(path.dirname(branchFile), { recursive: true });
  await writeFile(
    branchFile,
    `${JSON.stringify(createFixture(repositoryKey, storageRoot, branch), null, 2)}\n`,
    "utf8",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageRoot, "dist", "mcp-server.cjs")],
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({
    name: "revloop-smoke",
    version: "0.0.1",
  });
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "read_comments",
    "reply_to_comment",
  ]);

  const readResult = await client.callTool({
    name: "read_comments",
    arguments: {
      repositoryRoot,
    },
  });
  const readPayload = parseTextResult(readResult);
  assert.equal(readPayload.count, 1);
  assert.equal(readPayload.threads[0].id, "thread-1");

  await client.callTool({
    name: "reply_to_comment",
    arguments: {
      repositoryRoot,
      threadId: "thread-1",
      body: "Updated the implementation.",
      outcome: "changed",
    },
  });

  const saved = JSON.parse(await readFile(branchFile, "utf8"));
  assert.deepEqual(saved.threads[0].messages.at(-1), {
    id: saved.threads[0].messages.at(-1).id,
    author: "agent",
    body: "Updated the implementation.",
    createdAt: saved.threads[0].messages.at(-1).createdAt,
    outcome: "changed",
  });
  assert.equal(saved.threads[0].status, "open");

  await client.close();
} finally {
  await rm(repositoryRoot, { recursive: true, force: true });
  await rm(pluginRoot, { recursive: true, force: true });
}

async function initializeRepository(root) {
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Revloop Test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.email", "revloop@example.test"], {
    cwd: root,
  });
  await writeFile(path.join(root, "README.md"), "# Test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: root });
}

function createFixture(repositoryKey, storageRoot, branch) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    revision: 1,
    repository: {
      key: repositoryKey,
      rootPath: repositoryRoot,
      displayName: path.basename(repositoryRoot),
      storageRoot,
    },
    branch,
    threads: [
      {
        id: "thread-1",
        repositoryKey,
        branch,
        filePath: "src/example.ts",
        languageId: "typescript",
        status: "open",
        originalAnchor: createAnchor(now),
        currentAnchor: createAnchor(now),
        anchorHistory: [
          {
            kind: "created",
            at: now,
            toRange: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
          },
        ],
        diffContext: {
          header: "header",
          hunk: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
        },
        messages: [
          {
            id: randomUUID(),
            author: "user",
            body: "Please update this.",
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function createAnchor(capturedAt) {
  return {
    filePath: "src/example.ts",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    selectedText: "value",
    beforeContext: [],
    afterContext: [],
    contentHash: "hash",
    capturedAt,
  };
}

function parseTextResult(result) {
  const content = result.content?.find((item) => item.type === "text");
  assert.ok(content, "MCP tool did not return text content.");
  return JSON.parse(content.text);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
