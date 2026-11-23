import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pluginDirectory = path.resolve(import.meta.dirname, "..", "plugin");

const child = await execFileAsync(
  "copilot",
  ["plugin", "install", pluginDirectory],
  {
    cwd: path.dirname(pluginDirectory),
    encoding: "utf8",
  },
);

process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
