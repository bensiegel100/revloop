import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.join(
        repositoryRoot,
        "vscode",
        "test",
        "helpers",
        "vscodeMock.mjs",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      exclude: ["test/**"],
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 90,
      },
    },
  },
});
