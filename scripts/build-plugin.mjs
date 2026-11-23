import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "mcp", "dist", "mcp-server.cjs");
const destinationDirectory = path.join(root, "plugin", "server");
const destination = path.join(destinationDirectory, "mcp-server.cjs");

await rm(destinationDirectory, { recursive: true, force: true });
await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
await chmod(destination, 0o755);
