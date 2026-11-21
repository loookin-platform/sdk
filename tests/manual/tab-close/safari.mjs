// Tab close test in real Safari on macOS. The script opens a tab, you close it
// by hand (Cmd+W) within a few seconds. Automation cannot do it: Playwright's
// WebKit skips the lifecycle events and scripting Safari needs a system
// permission.
// Usage: npm run test:tabclose:safari [-- rounds]
import { execFileSync } from "node:child_process";
import { QUEUED, pageUrl, percent, runName, sleep, startServers } from "./server.mjs";

const ROUNDS = Number(process.argv[2] ?? 5);
const REQUIRED = 95;
/** The SDK sends the queue by itself after 10 s; later arrivals prove nothing. */
const TIMER_MS = 9000;
const ROUND_MS = 13000;

const servers = startServers();
let queued = 0;
let arrived = 0;

console.log(`Safari opens a tab ${ROUNDS} times, one every ${ROUND_MS / 1000} s. Close each tab right away with Cmd+W.`);

for (let round = 0; round < ROUNDS; round++) {
  const name = runName("safari", round);
  execFileSync("open", ["-a", "Safari", pageUrl(name)]);
  for (let i = 0; i < 60 && !servers.read(name).readyAt; i++) await sleep(250);
  if (!servers.read(name).readyAt) {
    console.log(`Round ${round + 1}/${ROUNDS}: the page did not load, skipped.`);
    continue;
  }
  console.log(`Round ${round + 1}/${ROUNDS}: close the tab now.`);
  await sleep(ROUND_MS);

  const state = servers.read(name);
  const delay = state.firstBatchAt ? state.firstBatchAt - state.readyAt : undefined;
  // Counted only when the tab was closed before the timer could have sent
  // the queue. A closed tab that delivered nothing counts as a loss.
  const closedInTime = state.hidden && (delay === undefined || delay < TIMER_MS);
  const when = delay === undefined ? "never" : `${(delay / 1000).toFixed(1)} s after load`;
  console.log(`  arrived ${state.arrived}/${QUEUED}, ${when}: ${closedInTime ? "counted" : "skipped, the tab was not closed in time"}`);
  if (closedInTime) {
    queued += QUEUED;
    arrived += state.arrived;
  }
}

servers.stop();
const share = percent(arrived, queued);
console.log({ queued, arrived, percent: share });
if (share === null) console.log("No round counted. Run it again and close each tab within a few seconds.");
else console.log(share >= REQUIRED ? `Passed: at least ${REQUIRED} %.` : `FAILED: under ${REQUIRED} %.`);
process.exit(share !== null && share >= REQUIRED ? 0 : 1);
