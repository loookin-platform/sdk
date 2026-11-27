// Fails when a gzipped browser entry is larger than its budget, when
// server-only code found its way into one, or when the browser entry
// imports anything other than the surveys entry (one dynamic import), or
// when either entry could turn text into markup or code.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUDGETS = { "dist/browser.js": 5000, "dist/surveys.js": 18000 };
const gzipped = (file) => gzipSync(readFileSync(file), { level: 9 }).length;

let failed = false;
const fail = (message) => {
  console.error(message);
  failed = true;
};

for (const [file, limit] of Object.entries(BUDGETS)) {
  const bytes = gzipped(file);
  console.log(`${file}: ${bytes} B gzipped (limit ${limit} B)`);
  if (bytes > limit) fail(`${file}: size budget exceeded by ${bytes - limit} B.`);
}
console.log(`dist/node.js: ${gzipped("dist/node.js")} B gzipped (no limit)`);

const browser = readFileSync("dist/browser.js", "utf8");
const surveys = readFileSync("dist/surveys.js", "utf8");
const staticImport = /import\s*[{"'*]|export\s*[*{][^;]*from\s*["']/;

if (staticImport.test(browser)) fail("dist/browser.js imports another file statically.");
const dynamic = browser.match(/import\s*\(/g) ?? [];
if (dynamic.length !== 1 || !browser.includes('import("./surveys.js")')) {
  fail(`dist/browser.js must have exactly one dynamic import, import("./surveys.js"); found ${dynamic.length}.`);
}
if (staticImport.test(surveys) || /import\s*\(/.test(surveys)) fail("dist/surveys.js imports another file.");
const UNSAFE = /innerHTML|insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function/;
for (const [file, code] of [
  ["dist/browser.js", browser],
  ["dist/surveys.js", surveys],
]) {
  if (/platform:"server"/.test(code)) fail(`${file} contains server code.`);
  const unsafe = UNSAFE.exec(code);
  if (unsafe) fail(`${file} uses ${unsafe[0]}: definitions must never become markup or code.`);
}

if (failed) process.exit(1);
