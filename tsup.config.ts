import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per public export in package.json. No shared chunks: each
  // entry is self-contained, so the browser file carries no server code.
  // The browser entry loads the surveys entry with import("./surveys.js"),
  // which stays a dynamic import of the published file.
  entry: { browser: "src/browser.ts", node: "src/node.ts", surveys: "src/surveys.ts" },
  splitting: false,
  format: ["esm"],
  target: "es2020",
  dts: true,
  minify: true,
  sourcemap: true,
  clean: true,
  esbuildPlugins: [
    {
      name: "surveys-entry-stays-external",
      setup(build) {
        build.onResolve({ filter: /^\.\/surveys\.js$/ }, (args) => ({ path: args.path, external: true }));
      },
    },
  ],
});
