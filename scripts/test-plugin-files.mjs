import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repositoryRoot, "plugin");
/** @type {unknown} */
const manifestValue = JSON.parse(
  await readFile(path.join(root, "plugin.json"), "utf8"),
);
/** @type {unknown} */
const mcpValue = JSON.parse(
  await readFile(path.join(root, "mcp.json"), "utf8"),
);
const skill = await readFile(
  path.join(root, "skills", "review-comments", "SKILL.md"),
  "utf8",
);
/** @type {unknown} */
const marketplaceValue = JSON.parse(
  await readFile(
    path.join(repositoryRoot, ".github", "plugin", "marketplace.json"),
    "utf8",
  ),
);

assert.ok(isRecord(manifestValue));
assert.ok(isRecord(mcpValue));
assert.ok(isRecord(marketplaceValue));
const mcpServers = mcpValue.mcpServers;
assert.ok(isRecord(mcpServers));
const revloopServer = mcpServers.revloop;
assert.ok(isRecord(revloopServer));
const marketplacePlugins = marketplaceValue.plugins;
assert.ok(isRecordArray(marketplacePlugins));
const marketplacePlugin = marketplacePlugins[0];
assert.ok(marketplacePlugin !== undefined);

const manifest = manifestValue;
assert.equal(manifest.name, "revloop");
assert.equal(revloopServer.type, "stdio");
assert.equal(marketplaceValue.name, "revloop");
assert.equal(marketplacePlugin.name, "revloop");
assert.equal(marketplacePlugin.source, "plugin");
assert.match(skill, /^---\nname: review-comments\n/m);
await access(path.join(root, "server", "mcp-server.cjs"));

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>[]}
 */
function isRecordArray(value) {
  return Array.isArray(value) && value.every(isRecord);
}
