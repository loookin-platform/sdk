import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per public export in package.json. No shared chunks: each
  // entry is self-contained, so the browser file carries no server code.
  entry: { browser: "src/browser.ts", node: "src/node.ts" },
  splitting: false,
  format: ["esm"],
  target: "es2020",
  dts: true,
  minify: true,
  sourcemap: true,
  clean: true,
});
