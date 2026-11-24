const assert = require("node:assert/strict");
const { realpath } = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

async function run() {
  const repositoryRoot = await getRepositoryRoot();
  const extension = vscode.extensions.getExtension("bensiegel.revloop");
  assert.ok(extension, "The development extension was not discovered.");

  await extension.activate();
  assert.equal(extension.isActive, true, "The extension did not activate.");
  await assertCommandsRegistered();
  await vscode.commands.executeCommand("revloop.startWorkingTreeReview");

  const commentController = vscode.comments.createCommentController(
    "revloop-extension-test",
    "Revloop Extension Test",
  );
  let client;
  try {
    await createUserComment(repositoryRoot, commentController);
    client = await createMcpClient();

    const open = await waitForComments(client, repositoryRoot, "open", 1);
    const thread = open.threads[0];
    assert.equal(open.branch, "refs/heads/feature/review");
    assert.equal(thread.filePath, "src/example.ts");
    assert.equal(thread.messages.length, 1);
    assert.equal(
      thread.messages[0].body,
      "Please make this greeting more welcoming.",
    );

    const replyResult = parseTextResult(
      await client.callTool({
        name: "reply_to_comment",
        arguments: {
          repositoryRoot,
          threadId: thread.id,
          body: "Updated the greeting and kept the behavior covered.",
          outcome: "changed",
        },
      }),
    );
    assert.equal(replyResult.status, "open");

    const replied = await waitForThread(client, repositoryRoot, thread.id, {
      status: "open",
      messageCount: 2,
    });
    assert.deepEqual(replied.messages.at(-1), {
      id: replied.messages.at(-1).id,
      author: "agent",
      body: "Updated the greeting and kept the behavior covered.",
      createdAt: replied.messages.at(-1).createdAt,
      outcome: "changed",
    });

    await vscode.commands.executeCommand("revloop.resolveThread", thread.id);
    const resolved = await waitForThread(client, repositoryRoot, thread.id, {
      status: "resolved",
      messageCount: 2,
    });
    assert.equal(resolved.status, "resolved");

    await vscode.commands.executeCommand("revloop.reopenThread", thread.id);
    const reopened = await waitForThread(client, repositoryRoot, thread.id, {
      status: "open",
      messageCount: 2,
    });
    assert.equal(reopened.status, "open");
  } finally {
    await client?.close();
    commentController.dispose();
  }
}

async function assertCommandsRegistered() {
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "revloop.startWorkingTreeReview",
    "revloop.startBranchReview",
    "revloop.addThread",
    "revloop.replyToThread",
    "revloop.editComment",
    "revloop.saveComment",
    "revloop.cancelCommentEdit",
    "revloop.resolveThread",
    "revloop.reopenThread",
    "revloop.openFile",
    "revloop.refresh",
  ]) {
    assert.ok(commands.includes(command), `Missing command: ${command}`);
  }
}

async function createUserComment(repositoryRoot, controller) {
  const uri = vscode.Uri.file(path.join(repositoryRoot, "src", "example.ts"));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const line = document.lineAt(1);
  const thread = controller.createCommentThread(uri, line.range, []);

  await vscode.commands.executeCommand("revloop.replyToThread", {
    thread,
    text: "Please make this greeting more welcoming.",
  });
}

async function createMcpClient() {
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/client/stdio");
  const transport = new StdioClientTransport({
    command: requiredEnvironment("REVLOOP_NODE_PATH"),
    args: [requiredEnvironment("REVLOOP_MCP_SERVER_PATH")],
    cwd: requiredEnvironment("REVLOOP_MCP_SERVER_CWD"),
    stderr: "pipe",
  });
  const client = new Client({
    name: "revloop-extension-test",
    version: "0.0.1",
  });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "read_comments",
    "reply_to_comment",
  ]);
  return client;
}

async function waitForComments(client, repositoryRoot, status, count) {
  return waitFor(
    `Revloop comments with status ${status}`,
    async () =>
      parseTextResult(
        await client.callTool({
          name: "read_comments",
          arguments: {
            repositoryRoot,
            status,
          },
        }),
      ),
    (result) => result.threads.length === count,
  );
}

async function waitForThread(client, repositoryRoot, threadId, expected) {
  const result = await waitForComments(client, repositoryRoot, "all", 1);
  return waitFor(
    `Revloop thread ${threadId}`,
    async () => {
      const current = parseTextResult(
        await client.callTool({
          name: "read_comments",
          arguments: {
            repositoryRoot,
            status: "all",
          },
        }),
      );
      return current.threads.find((thread) => thread.id === threadId);
    },
    (thread) =>
      thread !== undefined &&
      thread.status === expected.status &&
      thread.messages.length === expected.messageCount,
    result.threads.find((thread) => thread.id === threadId),
  );
}

async function waitFor(description, read, matches, initialValue) {
  const timeoutAt = Date.now() + 5_000;
  let value = initialValue;
  while (Date.now() < timeoutAt) {
    value ??= await read();
    if (matches(value)) {
      return value;
    }
    value = undefined;
    await delay(100);
  }

  assert.fail(`Timed out waiting for ${description}.`);
}

async function getRepositoryRoot() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "The fixture repository was not opened.");
  return realpath(workspaceFolder.uri.fsPath);
}

function parseTextResult(result) {
  const content = result.content?.find((item) => item.type === "text");
  assert.ok(content, "MCP tool did not return text content.");
  try {
    return JSON.parse(content.text);
  } catch (error) {
    throw new Error(`MCP tool returned invalid JSON: ${content.text}`, {
      cause: error,
    });
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `Missing environment variable: ${name}`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

module.exports = { run };
