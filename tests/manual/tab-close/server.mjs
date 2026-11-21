// Two local servers for the tab close test: the test page on one origin and a
// counting stand-in for the ingest on another, like a real workspace.
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PAGE_ORIGIN = "http://localhost:4100";
export const INGEST_ORIGIN = "http://localhost:4101";
/** Fewer than the SDK's flush threshold (30), so every event stays queued. */
export const QUEUED = 20;
/** How long the "inflight" case keeps its first request unanswered. */
const SLOW_MS = 4000;

/** The case is the second part of a run name: tabclose_<case>_... */
const caseOf = (name) => name.split("_")[1];

const SDK_FILE = fileURLToPath(new URL("../../../dist/browser.js", import.meta.url));

// The page tracks QUEUED events named after `?e=` as soon as it loads and
// reports its own lifecycle, so a run can tell a closed tab from an open one.
// The name carries the case (see caseOf): "backoff" has the whole queue
// refused once, so it waits for a retry; "inflight" has the first half on its
// way, unanswered, with the second half queued behind it.
const PAGE = `<!doctype html>
<meta charset="utf-8" />
<title>@loookin/sdk tab close test</title>
<p>Automated test of @loookin/sdk. This tab is safe to close.</p>
<script type="module">
  import { loookin } from "/sdk.js";
  const name = new URLSearchParams(location.search).get("e");
  const signal = (what) => navigator.sendBeacon("${INGEST_ORIGIN}/signal?e=" + name + "&s=" + what, "x");
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") signal("hidden");
  });
  window.addEventListener("pagehide", () => signal("hidden"));
  loookin.init({ workspace: "${INGEST_ORIGIN}", key: "pub_test" });
  loookin.identify("user-1", { company: "company-1" });
  const mode = name.split("_")[1];
  const track = (from, to) => {
    for (let i = from; i < to; i++) loookin.track(name, { position: i });
  };
  if (mode === "inflight") {
    track(0, ${QUEUED} / 2);
    void loookin.flush();
    track(${QUEUED} / 2, ${QUEUED});
  } else {
    track(0, ${QUEUED});
    if (mode === "backoff") await loookin.flush();
  }
  signal("ready");
</script>`;

function cors(req) {
  return {
    "Access-Control-Allow-Origin": req.headers.origin ?? "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

/**
 * Starts both servers. `read(name)` tells what arrived for one event name:
 * how many distinct events, when the first batch came, when the page was
 * ready and whether it reported being hidden.
 */
export function startServers() {
  let sdk;
  try {
    sdk = readFileSync(SDK_FILE, "utf8");
  } catch {
    throw new Error("dist/browser.js is missing. Run `npm run build` first.");
  }

  const runs = new Map();
  const run = (name) => {
    if (!runs.has(name)) runs.set(name, { ids: new Set(), batches: 0, firstBatchAt: undefined, readyAt: undefined, hidden: false });
    return runs.get(name);
  };

  const page = http.createServer((req, res) => {
    if (req.url === "/sdk.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(sdk);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE);
  });

  const ingest = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      return res.end();
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url, INGEST_ORIGIN);
      let accepted = 0;
      let delay = 0;
      if (url.pathname === "/signal") {
        const state = run(url.searchParams.get("e"));
        if (url.searchParams.get("s") === "ready") state.readyAt ??= Date.now();
        else state.hidden = true;
      } else {
        let events = [];
        try {
          events = JSON.parse(body).events ?? [];
        } catch {
          // A broken body counts as nothing received.
        }
        const name = events[0]?.event ?? "";
        const first = run(name).batches++ === 0;
        if (first && caseOf(name) === "backoff") {
          // Refused and not counted: the SDK holds the batch for its retry.
          res.writeHead(503, { ...cors(req), "Retry-After": "30", "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "unavailable" }));
        }
        for (const event of events) {
          const state = run(event.event);
          state.firstBatchAt ??= Date.now();
          state.ids.add(event.eventId);
        }
        accepted = events.length;
        if (first && caseOf(name) === "inflight") delay = SLOW_MS;
      }
      setTimeout(() => {
        res.writeHead(202, { ...cors(req), "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { accepted, errors: [], throttled: [] } }));
      }, delay);
    });
  });

  page.listen(new URL(PAGE_ORIGIN).port);
  ingest.listen(new URL(INGEST_ORIGIN).port);

  return {
    read(name) {
      const state = run(name);
      return { arrived: state.ids.size, firstBatchAt: state.firstBatchAt, readyAt: state.readyAt, hidden: state.hidden };
    },
    stop() {
      page.close();
      ingest.close();
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A name no earlier run or forgotten tab can share. */
export const runName = (label, round) => `tabclose_${label}_${Date.now().toString(36)}_${round}`;

export const pageUrl = (name) => `${PAGE_ORIGIN}/?e=${name}`;

export const percent = (arrived, queued) => (queued ? Math.round((arrived / queued) * 1000) / 10 : null);
