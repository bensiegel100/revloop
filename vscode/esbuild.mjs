import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/extension.ts", "src/reviewController.ts"],
  bundle: true,
  format: "esm",
  minify: !watch,
  sourcemap: true,
  sourcesContent: false,
  platform: "node",
  target: "node22",
  outdir: "dist",
  external: ["vscode", "./reviewController.js"],
  logLevel: "info",
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
