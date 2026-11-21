// Tab close test in Chromium, Firefox and WebKit through Playwright, and in
// the installed Google Chrome when there is one.
// Usage: npm run test:tabclose [-- rounds [case]]
import { chromium, firefox, webkit } from "playwright";
import { QUEUED, pageUrl, percent, runName, sleep, startServers } from "./server.mjs";

const ROUNDS = Number(process.argv[2] ?? 5);
const ONLY = process.argv[3];
/** Required share of queued events that must arrive (SC-003). */
const REQUIRED = 95;

const WAYS = {
  "tab closed": (page) => page.close({ runBeforeUnload: true }),
  "tab killed": (page) => page.close(),
  "navigated away": (page) => page.goto("about:blank"),
};

// What the queue looks like when the page goes away (see the page in
// server.mjs). The two harder cases are tried two ways to keep the run short.
const CASES = {
  queue: Object.keys(WAYS),
  backoff: ["tab closed", "navigated away"],
  inflight: ["tab closed", "navigated away"],
};

// Playwright's WebKit destroys a closed page without pagehide or
// visibilitychange, so closing a tab cannot be measured there. Safari is
// covered by safari.mjs with a tab closed by hand.
const skipped = (engine, way) => engine === "webkit" && way !== "navigated away";

const servers = startServers();
const rows = [];
let failed = false;

const ENGINES = [
  ["chromium", chromium, {}],
  ["chrome", chromium, { channel: "chrome" }],
  ["firefox", firefox, {}],
  ["webkit", webkit, {}],
];

for (const [engine, type, options] of ENGINES) {
  let browser;
  try {
    browser = await type.launch(options);
  } catch {
    // Only the installed Chrome may be missing; the bundled engines must start.
    if (!options.channel) throw new Error(`${engine} did not start. Run \`npx playwright install\` first.`);
    rows.push({ engine, case: "all", way: "all", queued: "-", arrived: "-", percent: "not installed" });
    continue;
  }
  for (const [kind, ways] of Object.entries(CASES)) {
    if (ONLY && kind !== ONLY) continue;
    for (const way of ways) {
      if (skipped(engine, way)) {
        rows.push({ engine, case: kind, way, queued: "-", arrived: "-", percent: "not measurable" });
        continue;
      }
      let queued = 0;
      let arrived = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const name = runName(kind === "queue" ? engine : `${kind}_${engine}`, round);
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(pageUrl(name));
        for (let i = 0; i < 50 && !servers.read(name).readyAt; i++) await sleep(100);
        // The request in flight must have reached the server before the page goes.
        for (let i = 0; kind === "inflight" && i < 50 && !servers.read(name).arrived; i++) await sleep(100);
        // Anything that arrived before the page went away was not in the queue.
        const before = servers.read(name).arrived;
        await WAYS[way](page);
        await sleep(2500);
        await context.close().catch(() => {});
        queued += QUEUED - before;
        arrived += servers.read(name).arrived - before;
      }
      const share = percent(arrived, queued);
      if (share === null || share < REQUIRED) failed = true;
      rows.push({ engine, case: kind, way, queued, arrived, percent: share });
    }
  }
  await browser.close();
}

servers.stop();
console.table(rows);
console.log(failed ? `FAILED: under ${REQUIRED} % somewhere.` : `Passed: at least ${REQUIRED} % everywhere it can be measured.`);
process.exit(failed ? 1 : 0);
