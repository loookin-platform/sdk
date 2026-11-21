// Fails when the gzipped browser entry is larger than the budget, or when
// server-only code found its way into it.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const LIMIT = 5000;
const gzipped = (file) => gzipSync(readFileSync(file), { level: 9 }).length;

const bytes = gzipped("dist/browser.js");
console.log(`dist/browser.js: ${bytes} B gzipped (limit ${LIMIT} B)`);
console.log(`dist/node.js: ${gzipped("dist/node.js")} B gzipped (no limit)`);

if (bytes > LIMIT) {
  console.error(`Size budget exceeded by ${bytes - LIMIT} B.`);
  process.exit(1);
}
if (/import\s*[{"']|platform:"server"/.test(readFileSync("dist/browser.js", "utf8"))) {
  console.error("dist/browser.js imports another file or contains server code.");
  process.exit(1);
}
