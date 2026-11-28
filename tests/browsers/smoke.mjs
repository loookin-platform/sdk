// Real-browser smoke test of the surveys renderer in Chromium, Firefox and
// WebKit (Playwright), against the built dist/. One page per engine:
// 1. the live flow, network stubbed with page.route: Popup, Modal, Banner,
//    Tooltip and Embed each show with a visible box and send survey_viewed;
// 2. mountSurveyPreview on a scrolled page: each format inside its target,
//    and the target given back on destroy; also into an element of an iframe.
// Usage: npm run build && npm run test:browsers [-- chromium,webkit]
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const ORIGIN = "https://acme.loookin.com";
const ENGINES = { chromium, firefox, webkit };
const only = (process.argv[2] ?? "chromium,firefox,webkit").split(",");

const PAGE = `<!doctype html>
<meta charset="utf-8" />
<title>@loookin/sdk browser smoke test</title>
<style>body{margin:0;font:16px sans-serif} .filler{height:1400px} #target{width:800px;height:500px;margin:20px;border:1px solid #ccc}</style>
<button id="help" style="margin:200px 0 0 300px">Help</button>
<div id="feedback" style="width:500px"></div>
<div class="filler"></div>
<div id="target"><p id="orig">Original content</p></div>
<div class="filler"></div>
<iframe id="frame" style="width:600px;height:400px" srcdoc="<div id='inner' style='width:500px;height:300px'><p>Inside</p></div>"></iframe>`;

function serve() {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    const file = path.match(/^\/dist\/([a-z]+\.js)$/)?.[1];
    if (!file) return res.writeHead(404).end();
    let code;
    try {
      code = readFileSync(DIST + file);
    } catch {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { "content-type": "text/javascript" }).end(code);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const base = { description: "", button: "Next", required: false };
function definition(key, format, design = {}) {
  return {
    key,
    versionId: "v1",
    format,
    schema: 1,
    priority: "medium",
    isTest: false,
    showAgain: true,
    language: "en",
    triggers: [],
    design: { accentColor: "#006eff", pageBg: "#f7f7f8", cardBg: "#ffffff", textColor: "#1a1a1e", borderRadius: 12, font: "inherit", edge: "shadow", progress: true, closeButton: true, ...design },
    steps: [
      { ...base, key: "s_1", title: "How likely are you to recommend us?", type: "rating", scale: "nps", lowLabel: "Not likely", highLabel: "Very likely" },
      { ...base, key: "s_end", title: "Thanks!", type: "thanks", button: "" },
    ],
  };
}
const SURVEYS = [
  definition("pop", "popup", { position: "bottom-right" }),
  definition("mod", "modal"),
  definition("bar", "banner", { position: "bottom" }),
  definition("tip", "tooltip", { anchor: "#help" }),
  definition("inline", "embed", { closeButton: undefined }),
];

/** In the page: the card of a survey element (in `scope`) with its box and visibility, or why there is none. */
const CARD = ([scope, format]) => {
  const hosts = Array.from(document.querySelectorAll(scope + " loookin-survey"));
  for (const host of hosts) {
    const card = host.shadowRoot?.querySelector(".card." + format);
    if (!card) continue;
    const r = card.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: r.left, y: r.top, right: r.right, bottom: r.bottom, visibility: getComputedStyle(card).visibility };
  }
  return { missing: `${hosts.length} survey element(s), no .card.${format}` };
};

async function run(name) {
  const errors = [];
  const fail = (what) => errors.push(what);
  const browser = await ENGINES[name].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => fail(`page error: ${e.message}`));
    const viewed = [];
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = route.request().url();
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (url.endsWith("/api/sdk/surveys")) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ data: { surveys: SURVEYS, ttl: 300 } }) });
      if (url.endsWith("/events")) {
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (body.event === "survey_viewed") viewed.push(url.split("/").slice(-2)[0]);
        return route.fulfill({ status: 204, headers: cors });
      }
      if (url.endsWith("/responses")) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: '{"data":{"ok":true}}' });
      return route.fulfill({ status: 202, headers: cors, contentType: "application/json", body: '{"data":{"accepted":0,"rejected":0,"errors":[],"warnings":[]}}' });
    });
    const server = await serve();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);

    // 1. Live.
    await page.evaluate(async () => {
      const { loookin } = await import("/dist/browser.js");
      window.loookin = loookin;
      loookin.init({ workspace: "acme", key: "pub_test" });
      loookin.identify("user-1", { company: "company-1" });
      loookin.mountSurvey("inline", "#feedback");
    });
    const visible = async (scope, format, key) => {
      try {
        await page.waitForFunction(([s, f]) => {
          for (const host of document.querySelectorAll(s + " loookin-survey")) {
            const card = host.shadowRoot?.querySelector(".card." + f);
            const r = card?.getBoundingClientRect();
            if (r && r.width > 0 && r.height > 0 && getComputedStyle(card).visibility === "visible") return true;
          }
          return false;
        }, [scope, format], { timeout: 3000 });
      } catch {
        return fail(`${name} live ${format}: not visible ${JSON.stringify(await page.evaluate(CARD, [scope, format]))}`);
      }
      if (key && !viewed.includes(key)) fail(`${name} live ${format}: no survey_viewed`);
    };
    const closeOpen = () =>
      page.evaluate(() => {
        for (const host of document.querySelectorAll("body > loookin-survey")) {
          if (host.shadowRoot?.querySelector(".card.tooltip")) continue;
          host.shadowRoot?.querySelector("button[aria-label=Close]")?.click();
        }
      });
    await visible("#feedback", "embed", "inline");
    for (const [key, format] of [["pop", "popup"], ["mod", "modal"], ["bar", "banner"]]) {
      const shown = await page.evaluate((k) => window.loookin.showSurvey(k), key);
      if (!shown) fail(`${name} live ${format}: showSurvey resolved false`);
      await visible("body", format, key);
      await closeOpen();
    }
    if (!(await page.evaluate(() => window.loookin.showSurvey("tip")))) fail(`${name} live tooltip: showSurvey resolved false`);
    await visible("body", "tooltip", "tip");
    await page.evaluate(() => window.loookin.stop());

    // 2. Preview on a scrolled page.
    await page.evaluate((survey) => (window.SURVEY = survey), SURVEYS[0]);
    await page.evaluate(() => document.getElementById("target").scrollIntoView());
    for (const survey of SURVEYS) {
      const result = await page.evaluate(async ([survey, CARD]) => {
        const { mountSurveyPreview } = await import("/dist/surveys.js");
        const target = document.getElementById("target");
        const before = target.innerHTML;
        const preview = mountSurveyPreview(target, survey);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const card = new Function("return " + CARD)()(["#target", survey.format]);
        const t = target.getBoundingClientRect();
        preview.destroy();
        return { card, t: { x: t.left, y: t.top, right: t.right, bottom: t.bottom }, restored: target.innerHTML === before, scrollY };
      }, [survey, CARD.toString()]);
      const { card, t } = result;
      const where = `${name} preview ${survey.format}`;
      if (card.missing) fail(`${where}: ${card.missing}`);
      else if (!card.w || !card.h || card.visibility !== "visible") fail(`${where}: not visible ${JSON.stringify(card)}`);
      else if (card.x < t.x - 1 || card.y < t.y - 1 || card.right > t.right + 1 || card.bottom > t.bottom + 1) fail(`${where}: outside its target ${JSON.stringify(result)}`);
      if (!result.restored) fail(`${where}: target not restored`);
      if (result.scrollY < 1000) fail(`${where}: page not scrolled (${result.scrollY})`);
    }
    // 3. An element inside an iframe, from this document's SDK.
    const framed = await page.evaluate(async () => {
      const { mountSurveyPreview } = await import("/dist/surveys.js");
      const frame = document.getElementById("frame");
      frame.scrollIntoView();
      const target = frame.contentDocument.getElementById("inner");
      const before = target.innerHTML;
      const preview = mountSurveyPreview(target, window.SURVEY);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const card = target.querySelector("loookin-survey")?.shadowRoot?.querySelector(".card")?.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      preview.destroy();
      const inside = !!card && card.width > 0 && card.left >= t.left - 1 && card.right <= t.right + 1 && card.top >= t.top - 1 && card.bottom <= t.bottom + 1;
      return { inside, restored: target.innerHTML === before };
    });
    if (!framed.inside) fail(`${name} preview in an iframe: not drawn inside its target`);
    if (!framed.restored) fail(`${name} preview in an iframe: target not restored`);
    server.close();
  } finally {
    await browser.close();
  }
  return errors;
}

let failed = false;
for (const name of only) {
  const started = Date.now();
  let errors;
  try {
    errors = await run(name);
  } catch (error) {
    errors = [`${name}: ${error.message}`];
  }
  failed ||= errors.length > 0;
  console.log(`${name}: ${errors.length ? "FAIL" : "pass"} (${Date.now() - started} ms)`);
  for (const e of errors) console.log(`  ${e}`);
}
process.exit(failed ? 1 : 0);
