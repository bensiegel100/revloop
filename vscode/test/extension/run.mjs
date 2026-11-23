import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runTests } from "@vscode/test-electron";

const execFileAsync = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(directory, "../..");
const monorepoRoot = path.resolve(extensionRoot, "..");
const repositoryRoot = await mkdtemp(
  path.join(os.tmpdir(), "revloop-extension-"),
);
const serverWorkingDirectory = await mkdtemp(
  path.join(os.tmpdir(), "revloop-mcp-extension-"),
);
const inheritedGitEnvironment = clearRepositoryGitEnvironment();
const vscodeVersion = process.env.REVLOOP_VSCODE_TEST_VERSION;

try {
  await initializeRepository(repositoryRoot);
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  await runTests({
    ...(vscodeVersion === undefined ? {} : { version: vscodeVersion }),
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(directory, "suite.cjs"),
    extensionTestsEnv: {
      REVLOOP_MCP_SERVER_PATH: path.join(
        monorepoRoot,
        "mcp",
        "dist",
        "mcp-server.cjs",
      ),
      REVLOOP_MCP_SERVER_CWD: serverWorkingDirectory,
      REVLOOP_NODE_PATH: process.execPath,
    },
    launchArgs: [
      canonicalRepositoryRoot,
      "--disable-extensions",
      "--disable-workspace-trust",
    ],
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  restoreGitEnvironment(inheritedGitEnvironment);
  await Promise.all([
    rm(repositoryRoot, { recursive: true, force: true }),
    rm(serverWorkingDirectory, { recursive: true, force: true }),
  ]);
}

async function initializeRepository(rootPath) {
  await runGit(rootPath, ["init", "--initial-branch=main"]);
  await runGit(rootPath, ["config", "user.name", "Revloop Test"]);
  await runGit(rootPath, ["config", "user.email", "revloop@example.test"]);

  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(path.join(rootPath, "README.md"), "# Revloop fixture\n");
  await writeFile(
    path.join(rootPath, "src", "example.ts"),
    [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}.`;",
      "}",
      "",
    ].join("\n"),
  );
  await runGit(rootPath, ["add", "."]);
  await runGit(
    rootPath,
    ["commit", "-m", "Create review fixture"],
    "2026-01-01T00:00:00Z",
  );

  await writeFile(
    path.join(rootPath, "src", "stable.ts"),
    ["export const stable = true;", ""].join("\n"),
  );
  await runGit(rootPath, ["add", "."]);
  await runGit(
    rootPath,
    ["commit", "-m", "Add stable fixture"],
    "2026-01-01T00:01:00Z",
  );
  await runGit(rootPath, ["switch", "-c", "feature/review"]);

  await writeFile(
    path.join(rootPath, "src", "example.ts"),
    [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}! Welcome to Revloop.`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(rootPath, "src", "newFeature.ts"),
    ["export const featureEnabled = true;", ""].join("\n"),
  );
}

async function runGit(rootPath, args, timestamp) {
  await execFileAsync("git", args, {
    cwd: rootPath,
    env: {
      ...process.env,
      ...(timestamp === undefined
        ? {}
        : {
            GIT_AUTHOR_DATE: timestamp,
            GIT_COMMITTER_DATE: timestamp,
          }),
    },
  });
}

function clearRepositoryGitEnvironment() {
  const inherited = new Map();
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]) {
    if (name in process.env) {
      inherited.set(name, process.env[name]);
      delete process.env[name];
    }
  }
  return inherited;
}

function restoreGitEnvironment(inherited) {
  for (const [name, value] of inherited) {
    process.env[name] = value;
  }
}
