// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("package.json", () => {
  it("gives every entry a default condition next to import, so require() finds it", () => {
    const exports = JSON.parse(read("package.json")).exports as Record<string, Record<string, string>>;
    expect(Object.keys(exports)).toEqual([".", "./node"]);
    for (const entry of Object.values(exports)) {
      expect(entry.default).toBe(entry.import);
      expect(Object.keys(entry)[0]).toBe("types"); // conditions match in order
    }
  });
});

describe("README", () => {
  it("has a server example that compiles under strict", () => {
    const example = /```js\n(import \{ createClient \}[\s\S]*?)```/.exec(read("README.md"))?.[1];
    expect(example).toContain("createClient(");
    const file = resolve(root, "readme-example.ts");
    const source = example!.replace('"@loookin/sdk/node"', JSON.stringify(resolve(root, "src/node")));

    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: ["node"],
    };
    const host = ts.createCompilerHost(options);
    const { fileExists, readFile } = host;
    host.fileExists = (name) => name === file || fileExists(name);
    host.readFile = (name) => (name === file ? source : readFile(name));
    const problems = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
    expect(problems.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });
});
