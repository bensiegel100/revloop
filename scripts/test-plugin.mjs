import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugin");

const plugins = await run(["--plugin-dir", plugin, "plugin", "list"]);
assert.match(plugins, /revloop/i);

const skills = await run(["--plugin-dir", plugin, "skill", "list"]);
assert.match(skills, /review-comments/i);

const mcp = await run(["--plugin-dir", plugin, "mcp", "list"]);
assert.match(mcp, /revloop/i);

/**
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function run(args) {
  const { stdout, stderr } = await execFileAsync("copilot", args, {
    cwd: root,
    encoding: "utf8",
  });
  return `${stdout}\n${stderr}`;
}
