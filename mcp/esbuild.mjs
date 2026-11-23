import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  format: "cjs",
  minify: false,
  sourcemap: true,
  sourcesContent: false,
  platform: "node",
  target: "node20",
  outfile: "dist/mcp-server.cjs",
  logLevel: "info",
});
