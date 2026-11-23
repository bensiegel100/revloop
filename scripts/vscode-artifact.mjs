import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repositoryRoot, "vscode", "package.json");
const manifest = await readManifest();
const artifactFileName = `${manifest.name}-${manifest.version}.vsix`;
const artifactPath = path.join(repositoryRoot, artifactFileName);
const checksumFileName = `${artifactFileName}.sha256`;
const checksumPath = path.join(repositoryRoot, checksumFileName);
const command = process.argv.at(2) ?? "path";

switch (command) {
  case "checksum":
    await writeChecksum();
    break;
  case "github-output":
    await writeGitHubOutput();
    break;
  case "install":
    installArtifact();
    break;
  case "package":
    runVsce(["package", "--no-dependencies", "--out", artifactPath]);
    break;
  case "path":
    process.stdout.write(`${artifactFileName}\n`);
    break;
  case "publish":
    await readFile(artifactPath);
    runVsce([
      "publish",
      "--no-dependencies",
      "--oidc",
      "--packagePath",
      artifactPath,
      "--skip-duplicate",
    ]);
    break;
  default:
    throw new Error(`Unknown VS Code artifact command: ${command}`);
}

/**
 * @returns {Promise<{ name: string; version: string }>}
 */
async function readManifest() {
  /** @type {unknown} */
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(
      "The VS Code extension manifest is missing name or version.",
    );
  }
  return { name: value.name, version: value.version };
}

/**
 * @returns {void}
 */
function installArtifact() {
  const codeCli = process.platform === "win32" ? "code.cmd" : "code";
  execFileSync(codeCli, ["--install-extension", artifactPath, "--force"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

/**
 * @param {string[]} arguments_
 * @returns {void}
 */
function runVsce(arguments_) {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || npmCli.length === 0) {
    throw new Error("npm_execpath is required to run vsce.");
  }
  execFileSync(
    process.execPath,
    [npmCli, "exec", "--workspace", "revloop", "--", "vsce", ...arguments_],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
    },
  );
}

/**
 * @returns {Promise<void>}
 */
async function writeChecksum() {
  const digest = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  await writeFile(checksumPath, `${digest}  ${artifactFileName}\n`);
}

/**
 * @returns {Promise<void>}
 */
async function writeGitHubOutput() {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) {
    throw new Error("GITHUB_OUTPUT is required to write workflow outputs.");
  }
  await appendFile(
    outputPath,
    [
      `artifact_path=${artifactFileName}`,
      `checksum_path=${checksumFileName}`,
      `tag=v${manifest.version}`,
      `version=${manifest.version}`,
      "",
    ].join("\n"),
  );
}
