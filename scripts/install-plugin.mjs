import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const marketplaceName = "revloop";
const pluginName = "revloop";
const pluginId = `${pluginName}@${marketplaceName}`;
const marketplaceSource = `Local: ${repositoryRoot}`;

let marketplaces = await readRows(["plugin", "marketplace", "list", "--json"]);
let plugins = await readRows(["plugin", "list", "--json"]);
let marketplace = marketplaces.find(
  (candidate) => candidate.name === marketplaceName,
);
const hasDirectInstall = plugins.some(
  (candidate) =>
    candidate.name === pluginName &&
    candidate.marketplace === "" &&
    candidate.source === "installed",
);

if (
  hasDirectInstall ||
  (marketplace !== undefined && marketplace.source !== marketplaceSource)
) {
  if (marketplace !== undefined) {
    await run(["plugin", "marketplace", "remove", marketplaceName, "--force"]);
  }
  if (hasDirectInstall) {
    await run(["plugin", "uninstall", pluginName]);
  }
  marketplaces = await readRows(["plugin", "marketplace", "list", "--json"]);
  marketplace = marketplaces.find(
    (candidate) => candidate.name === marketplaceName,
  );
}

if (marketplace === undefined) {
  await run(["plugin", "marketplace", "add", repositoryRoot]);
}

plugins = await readRows(["plugin", "list", "--json"]);
const installed = plugins.find(
  (candidate) =>
    candidate.name === pluginName && candidate.marketplace === marketplaceName,
);
if (installed === undefined) {
  await run(["plugin", "install", pluginId]);
} else if (installed.enabled !== true) {
  await run(["plugin", "enable", pluginId]);
} else {
  process.stdout.write(
    `Plugin "${pluginId}" is already installed and enabled.\n`,
  );
}

/**
 * @param {string[]} arguments_
 * @returns {Promise<void>}
 */
async function run(arguments_) {
  const child = await execFileAsync("copilot", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
}

/**
 * @param {string[]} arguments_
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readRows(arguments_) {
  const child = await execFileAsync("copilot", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  /** @type {unknown} */
  const value = JSON.parse(child.stdout);
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(
      `Unexpected Copilot CLI output for ${arguments_.join(" ")}.`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
