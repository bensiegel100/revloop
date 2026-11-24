import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
/** @type {unknown} */
const extensionManifestValue = JSON.parse(
  await readFile(path.join(repositoryRoot, "vscode", "package.json"), "utf8"),
);
if (
  typeof extensionManifestValue !== "object" ||
  extensionManifestValue === null ||
  !("name" in extensionManifestValue) ||
  typeof extensionManifestValue.name !== "string" ||
  !("version" in extensionManifestValue) ||
  typeof extensionManifestValue.version !== "string"
) {
  throw new Error("The VS Code extension manifest is missing name or version.");
}
const extensionManifest = {
  name: extensionManifestValue.name,
  version: extensionManifestValue.version,
};
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "revloop-vscode-artifact-"),
);
const argumentsPath = path.join(temporaryDirectory, "arguments.json");
const codeCliPath = path.join(
  temporaryDirectory,
  process.platform === "win32" ? "code.cmd" : "code",
);

try {
  await writeFakeCodeCli();
  await execFileAsync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "vscode-artifact.mjs"), "install"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        REVLOOP_CODE_ARGUMENTS: argumentsPath,
        REVLOOP_CODE_CLI: codeCliPath,
      },
    },
  );
  /** @type {unknown} */
  const argumentsValue = JSON.parse(await readFile(argumentsPath, "utf8"));
  if (
    !Array.isArray(argumentsValue) ||
    !argumentsValue.every((value) => typeof value === "string")
  ) {
    throw new Error("The fake VS Code CLI produced invalid arguments.");
  }
  assert.deepEqual(argumentsValue, [
    "--install-extension",
    path.join(
      repositoryRoot,
      `${extensionManifest.name}-${extensionManifest.version}.vsix`,
    ),
    "--force",
  ]);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function writeFakeCodeCli() {
  if (process.platform === "win32") {
    await writeFile(
      codeCliPath,
      [
        "@echo off",
        "node -e \"require('node:fs').writeFileSync(process.env.REVLOOP_CODE_ARGUMENTS, JSON.stringify(process.argv.slice(1)))\" -- %*",
        "",
      ].join("\r\n"),
      "utf8",
    );
    return;
  }

  await writeFile(
    codeCliPath,
    [
      "#!/bin/sh",
      'node -e \'require("node:fs").writeFileSync(process.env.REVLOOP_CODE_ARGUMENTS, JSON.stringify(process.argv.slice(1)))\' -- "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(codeCliPath, 0o755);
}
