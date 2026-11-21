import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per public export. The server entry will be added here as
  // `node: "src/node.ts"` together with a "./node" export in package.json.
  entry: { browser: "src/browser.ts" },
  format: ["esm"],
  target: "es2020",
  dts: true,
  minify: true,
  sourcemap: true,
  clean: true,
});
