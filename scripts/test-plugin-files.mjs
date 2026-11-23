import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "plugin");
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

assert.ok(isRecord(manifestValue));
assert.ok(isRecord(mcpValue));
const mcpServers = mcpValue.mcpServers;
assert.ok(isRecord(mcpServers));
const revloopServer = mcpServers.revloop;
assert.ok(isRecord(revloopServer));

const manifest = manifestValue;
assert.equal(manifest.name, "revloop");
assert.equal(revloopServer.type, "stdio");
assert.match(skill, /^---\nname: review-comments\n/m);
await access(path.join(root, "server", "mcp-server.cjs"));

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
