// Fails when the gzipped browser entry is larger than the budget.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const LIMIT = 5000;
const file = "dist/browser.js";
const bytes = gzipSync(readFileSync(file), { level: 9 }).length;

console.log(`${file}: ${bytes} B gzipped (limit ${LIMIT} B)`);
if (bytes > LIMIT) {
  console.error(`Size budget exceeded by ${bytes - LIMIT} B.`);
  process.exit(1);
}
