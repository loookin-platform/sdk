// @vitest-environment jsdom
// Banner, Tooltip and Embed (0.3.0).
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { placeTooltip } from "../src/surveys/render/tooltip";
import type { SdkSurvey } from "../src/surveys/types";
import { json, mockFetch, mockSurveys, surveyCalls, surveyList } from "./helpers";
import { loadSdk as loadPage, setupPage, setWidth } from "./page";
import { $, $$, button, choice, rating, settle, setupSurveys, shadow, survey, text, thanks } from "./surveys-helpers";

setupPage();
setupSurveys();

/** Page observers outlive a test: every SDK copy of this file is stopped after its test. */
const copies: { stop(): void }[] = [];
async function loadSdk() {
  const sdk = await loadPage();
  copies.push(sdk);
  return sdk;
}
afterEach(() => {
  for (const sdk of copies.splice(0)) sdk.stop();
});

/** requestAnimationFrame on the fake clock (jsdom has none); `frames` counts the requests. */
let frames = 0;
beforeEach(() => {
  frames = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames++;
    return setTimeout(() => fn(Date.now()), 16) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

const events = () => surveyCalls.filter((c) => c.url.endsWith("/events")).map((c) => [c.url.split("/").slice(-2)[0], c.body.event]);
const hosts = () => Array.from(document.querySelectorAll("loookin-survey"));
const inside = (host: Element, selector: string) => host.shadowRoot!.querySelector<HTMLElement>(selector);

async function start(list: unknown[], identify = true) {
  mockFetch();
  mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList(list) : undefined));
  const loookin = await loadSdk();
  loookin.init({ workspace: "acme", key: "pub_abc" });
  if (identify) loookin.identify("u1", { company: "c1" });
  await settle();
  return loookin;
}

const described = (key: string) => ({ ...rating(key), description: "Say more" });
const banner = (extra: Partial<SdkSurvey> = {}) => survey({ key: "bar", format: "banner", design: { ...survey().design, position: "bottom" }, steps: [described("s_1"), text("s_2", "Why?", { long: true } as never), thanks()], ...extra });
const tooltip = (extra: Partial<SdkSurvey> = {}, anchor = "#help") =>
  survey({ key: "tip", format: "tooltip", design: { ...survey().design, position: undefined, anchor }, ...extra });
const embed = (key = "inline", extra: Partial<SdkSurvey> = {}) =>
  survey({ key, format: "embed", triggers: [], design: { ...survey().design, closeButton: undefined, position: undefined }, ...extra });

function element(id: string, tag = "div") {
  const el = document.createElement(tag);
  el.id = id;
  document.body.append(el);
  return el;
}

function box(el: Element, rect: { top: number; left: number; width: number; height: number }) {
  const r = { ...rect, bottom: rect.top + rect.height, right: rect.left + rect.width, x: rect.left, y: rect.top };
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ ...r, toJSON: () => r } as DOMRect);
}

describe("Banner", () => {
  it("on a wide screen draws the step in one row: question, control and button, without description, progress and Back", async () => {
    await start([banner()]);
    const card = $(".card")!;
    expect(card.classList.contains("banner")).toBe(true);
    expect(card.classList.contains("row")).toBe(true);
    expect(card.classList.contains("bottom")).toBe(true);
    expect($(".title")).not.toBeNull();
    expect($$(".scale button")).toHaveLength(11);
    expect($(".next")).not.toBeNull();
    expect($(".desc")).toBeNull();
    expect($(".progress")).toBeNull();
    button("9")!.click();
    $(".next")!.click();
    // A long text answer is a single line in the row, and there is still no Back.
    expect($("input.field")).not.toBeNull();
    expect($("textarea")).toBeNull();
    expect(button("Back")).toBeNull();
  });

  it("under 640 px stacks the step like the other formats", async () => {
    setWidth(500);
    await start([banner()]);
    const card = $(".card")!;
    expect(card.classList.contains("stack")).toBe(true);
    expect(card.classList.contains("row")).toBe(false);
    expect($(".desc")?.textContent).toBe("Say more");
    expect($(".progress")).not.toBeNull();
    button("9")!.click();
    $(".next")!.click();
    expect($("textarea")).not.toBeNull();
    expect(button("Back")).not.toBeNull();
  });

  it("switches the layout when the window crosses 640 px, keeping the answer, once per frame", async () => {
    await start([banner()]);
    button("7")!.click();
    setWidth(500);
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("resize"));
    expect(frames).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect($(".card")!.classList.contains("stack")).toBe(true);
    expect($(".desc")).not.toBeNull();
    expect(button("7")!.getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    ["an 11-point scale under 1000 px stacks", 900, "nps", "stack"],
    ["an 11-point scale from 1000 px is one row", 1000, "nps", "row"],
    ["5 stars under 1000 px stay one row", 900, "stars", "row"],
  ] as const)("never squeezes wide controls: %s", async (_, width, scale, layout) => {
    setWidth(width);
    await start([banner({ steps: [rating("s_1", scale), thanks()] })]);
    expect($(".card")!.classList.contains(layout)).toBe(true);
  });

  it("stacks a choice with more than 4 options under 1000 px", async () => {
    setWidth(900);
    await start([banner({ steps: [choice("s_1", ["a", "b", "c", "d", "e"]), thanks()] })]);
    expect($(".card")!.classList.contains("stack")).toBe(true);
  });

  it("keeps the keyboard order of the screen: question, answer, button, then Close", async () => {
    await start([banner()]);
    const card = $(".card")!;
    expect(card.lastElementChild!.classList.contains("bar")).toBe(true);
    const buttons = $$("button");
    expect(buttons[buttons.length - 1]!.getAttribute("aria-label")).toBe("Close");
    expect(buttons[buttons.length - 2]!.classList.contains("next")).toBe(true);
  });

  it("sits at the top edge when the Design says so", async () => {
    await start([banner({ design: { ...survey().design, position: "top" } })]);
    expect($(".card")!.className).toContain("top");
  });

  it("takes part in the one-at-a-time rule with Popup and Modal, in the server's order", async () => {
    await start([banner(), survey({ key: "pop" })]);
    expect(hosts()).toHaveLength(1);
    expect($(".card")!.classList.contains("banner")).toBe(true);
  });

  it("does not take the focus or lock scrolling, and closes with its close button", async () => {
    document.documentElement.removeAttribute("style");
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    await start([banner()]);
    expect(document.activeElement).toBe(outside);
    expect(document.documentElement.getAttribute("style")).toBeNull();
    button("Close")!.click();
    expect(shadow()).toBeNull();
  });

  it("removes its resize listener on close", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    await start([banner()]);
    button("Close")!.click();
    expect(remove.mock.calls.map(([type]) => type)).toContain("resize");
  });
});

/** An anchor with a box inside the viewport. */
function visible(id: string, rect = { top: 100, left: 100, width: 100, height: 20 }) {
  const el = element(id, "button");
  box(el, rect);
  return el;
}

/** Makes `:modal` match (jsdom has no showModal) while `on`, and tells the page a dialog opened or closed. */
function hostDialog() {
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  let on = false;
  const query = document.querySelector.bind(document);
  vi.spyOn(document, "querySelector").mockImplementation(((sel: string) => (sel === ":modal" ? (on ? dialog : null) : query(sel))) as typeof document.querySelector);
  return (open: boolean) => {
    on = open;
    if (open) dialog.setAttribute("open", "");
    else dialog.removeAttribute("open");
  };
}

describe("Tooltip", () => {
  it("is not shown, and nothing is reported, while its anchor is not on the page; it shows once the anchor appears", async () => {
    await start([tooltip()]);
    expect(hosts()).toHaveLength(0);
    expect(events()).toEqual([]);
    visible("help");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(hosts()).toHaveLength(1);
    expect(events()[0]).toEqual(["tip", "survey_viewed"]);
  });

  it.each([
    ["has no box", { top: 0, left: 0, width: 0, height: 0 }],
    ["is below the viewport", { top: 2000, left: 100, width: 100, height: 20 }],
  ])("is not shown while the anchor %s, and shows when the anchor becomes visible", async (_, rect) => {
    const scroll = fakeViewport();
    const anchor = visible("help", rect);
    await start([tooltip()]);
    scroll(1, anchor); // even an observer saying so is not enough without a box in view
    await settle();
    expect(hosts()).toHaveLength(0);
    expect(events()).toEqual([]);
    box(anchor, { top: 100, left: 100, width: 100, height: 20 });
    scroll(1, anchor);
    await settle();
    expect(hosts()).toHaveLength(1);
    expect(events()[0]).toEqual(["tip", "survey_viewed"]);
  });

  it("is not shown while checkVisibility() says the anchor is hidden", async () => {
    const anchor = visible("help");
    let shown = false;
    Object.assign(anchor, { checkVisibility: () => shown });
    const loookin = await start([tooltip({ triggers: [{ kind: "event", join: "and", event: "go" }] })]);
    loookin.track("go");
    await settle();
    expect(hosts()).toHaveLength(0);
    shown = true;
    loookin.track("go");
    await settle();
    expect(hosts()).toHaveLength(1);
  });

  it("waits for its anchor through an observer, not by sending anything: a clipped anchor shows nothing", async () => {
    const scroll = fakeViewport();
    const anchor = visible("help");
    await start([tooltip()]);
    scroll(0, anchor);
    await settle();
    expect(hosts()).toHaveLength(0);
    expect(events()).toEqual([]);
    scroll(1, anchor);
    await settle();
    expect(hosts()).toHaveLength(1);
  });

  it("never shows a definition without a usable anchor", async () => {
    visible("help");
    await start([tooltip({}, ""), tooltip({ key: "bad" }, "#help:has(p)")]);
    expect(hosts()).toHaveLength(0);
  });

  it("is placed next to its anchor and does not touch it", async () => {
    const anchor = visible("help");
    anchor.className = "cta";
    await start([tooltip()]);
    const card = $(".tooltip")!;
    expect(card.getAttribute("data-side")).toBe("bottom");
    expect(card.style.top).toBe("130px");
    expect(card.style.left).toBe("150px");
    expect($(".arrow")).not.toBeNull();
    expect(anchor.className).toBe("cta");
    expect(anchor.getAttribute("style")).toBeNull();
    expect(anchor.children).toHaveLength(0);
  });

  it("reads every size before it writes a style", async () => {
    const anchor = visible("help");
    const log: string[] = [];
    await start([tooltip()]);
    const card = $(".tooltip")!;
    vi.spyOn(card, "offsetWidth", "get").mockImplementation(() => (log.push("read"), 0));
    vi.spyOn(card.style, "setProperty").mockImplementation(((name: string) => void log.push(`write ${name}`)) as never);
    box(anchor, { top: 50, left: 100, width: 100, height: 20 });
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(20);
    expect(log[0]).toBe("read");
    expect(log.slice(1).every((l) => l.startsWith("write"))).toBe(true);
  });

  it("hides while its scroll container clips the anchor out of view", async () => {
    const scroll = fakeViewport();
    const anchor = visible("help");
    await start([tooltip()]);
    scroll(1, anchor);
    await settle();
    expect($(".tooltip")!.style.visibility).toBe("");
    scroll(0, anchor);
    await vi.advanceTimersByTimeAsync(20);
    expect($(".tooltip")!.style.visibility).toBe("hidden");
    scroll(1, anchor);
    await vi.advanceTimersByTimeAsync(20);
    expect($(".tooltip")!.style.visibility).toBe("");
  });

  it("picks the side with room and stays inside the viewport", () => {
    const view = { width: 400, height: 800 };
    const card = { width: 320, height: 200 };
    const at = (top: number, left: number) => placeTooltip({ top, left, bottom: top + 20, right: left + 40, width: 40, height: 20 }, card, view);
    expect(at(100, 10)).toMatchObject({ side: "bottom", top: 130, left: 8 });
    expect(at(700, 10)).toMatchObject({ side: "top", top: 490 });
    expect(at(700, 360).left).toBe(72); // clamped to the right edge
    expect(placeTooltip({ top: 300, left: 10, bottom: 600, right: 50, width: 40, height: 300 }, { width: 200, height: 400 }, { width: 400, height: 800 }).side).toBe("right");
  });

  it("follows the anchor on scroll through one throttled handler, removed on close", async () => {
    const anchor = visible("help");
    const remove = vi.spyOn(window, "removeEventListener");
    await start([tooltip()]);
    frames = 0;
    box(anchor, { top: 40, left: 100, width: 100, height: 20 });
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("scroll"));
    expect(frames).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect($(".tooltip")!.style.top).toBe("70px");

    button("Close")!.click();
    expect(remove.mock.calls.find(([type]) => type === "scroll")).toBeDefined();
    frames = 0;
    window.dispatchEvent(new Event("scroll"));
    expect(frames).toBe(0);
  });

  it("follows an anchor a framework re-rendered, reporting nothing; closes without a dismissal a few frames after it is gone for good", async () => {
    const anchor = visible("help");
    await start([tooltip()]);
    const before = events().length;
    anchor.remove();
    const again = visible("help", { top: 300, left: 100, width: 100, height: 20 });
    await vi.advanceTimersByTimeAsync(40);
    expect(hosts()).toHaveLength(1);
    expect($(".tooltip")!.style.top).toBe("330px");
    expect(events()).toHaveLength(before);

    again.remove();
    await vi.advanceTimersByTimeAsync(16 * 3);
    expect(hosts()).toHaveLength(1); // the grace period
    await vi.advanceTimersByTimeAsync(16 * 10);
    await settle();
    expect(hosts()).toHaveLength(0);
    expect(events().map(([, e]) => e)).not.toContain("survey_dismissed");
  });

  it("always has a close button, also when the Design turns it off", async () => {
    visible("help");
    await start([tooltip({ design: { ...survey().design, closeButton: false, anchor: "#help" } })]);
    expect(button("Close")).not.toBeNull();
  });

  it("does not compete with a Popup: both show", async () => {
    visible("help");
    await start([tooltip(), survey({ key: "pop" })]);
    const cards = hosts().map((h) => inside(h, ".card")!.className);
    expect(cards).toHaveLength(2);
    expect(cards.some((c) => c.includes("tooltip"))).toBe(true);
    expect(cards.some((c) => c.includes("popup"))).toBe(true);
  });

  it("shows at most one Tooltip per anchor", async () => {
    visible("help");
    await start([tooltip(), tooltip({ key: "tip2" })]);
    expect(hosts()).toHaveLength(1);
  });

  it("shows on a click on its trigger selector", async () => {
    visible("help");
    const buy = element("buy", "button");
    await start([tooltip({ triggers: [{ kind: "click", join: "and", selector: "#buy" }] })]);
    expect(hosts()).toHaveLength(0);
    buy.click();
    await settle();
    expect(hosts()).toHaveLength(1);
  });

  it("showSurvey shows a Tooltip that only the refreshed list has", async () => {
    visible("help");
    let n = 0;
    mockFetch();
    mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList(++n === 1 ? [survey({ key: "pop", triggers: [] })] : [tooltip({ triggers: [] })]) : undefined));
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", key: "pub_abc" });
    loookin.identify("u1");
    await settle();
    await vi.advanceTimersByTimeAsync(301_000);
    await expect(loookin.showSurvey("tip")).resolves.toBe(true);
    expect(inside(hosts()[0]!, ".card")!.classList.contains("tooltip")).toBe(true);
  });
});

describe("refused views are never sent in a loop", () => {
  const refusing = async (list: unknown[]) => {
    mockFetch();
    mockSurveys((call) => {
      if (call.url.endsWith("/surveys")) return surveyList(list);
      if (call.url.endsWith("/events")) return json(429, { error: "rate_limited" });
      return undefined;
    });
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", key: "pub_abc" });
    loookin.identify("u1");
    await settle();
    return loookin;
  };
  const viewed = () => events().filter(([, e]) => e === "survey_viewed").length;

  it("a Tooltip: page mutations and triggers do not send its view again", async () => {
    visible("help");
    const loookin = await refusing([tooltip({ triggers: [{ kind: "event", join: "and", event: "go" }] })]);
    loookin.track("go");
    await settle();
    expect(viewed()).toBe(1);
    for (let i = 0; i < 5; i++) {
      document.body.append(document.createElement("p"));
      loookin.track("go");
      await vi.advanceTimersByTimeAsync(600);
      await settle();
    }
    expect(viewed()).toBe(1);
    expect(hosts()).toHaveLength(0);
  });

  it("a Popup: later triggers and the late-anchor watch do not send its view again", async () => {
    const loookin = await refusing([survey({ key: "pop", triggers: [{ kind: "event", join: "and", event: "go" }] }), tooltip()]);
    for (let i = 0; i < 4; i++) {
      loookin.track("go");
      document.body.append(document.createElement("p"));
      await vi.advanceTimersByTimeAsync(600);
      await settle();
    }
    expect(viewed()).toBe(1);
  });
});

describe("a modal dialog of the page", () => {
  it("keeps a Popup from showing until it closes", async () => {
    const dialog = hostDialog();
    dialog(true);
    mockFetch();
    mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList([survey()]) : undefined));
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", key: "pub_abc" });
    loookin.identify("u1");
    await settle();
    expect(hosts()).toHaveLength(0);
    expect(events()).toEqual([]);
    dialog(false);
    await settle();
    expect(hosts()).toHaveLength(1);
  });

  it("hides an open Banner and Tooltip while it is open, and they come back after", async () => {
    const dialog = hostDialog();
    visible("help");
    await start([banner(), tooltip()]);
    expect(hosts()).toHaveLength(2);
    const roots = () => hosts().map((h) => inside(h, ".root")!.style.visibility);
    expect(roots()).toEqual(["", ""]);
    dialog(true);
    await settle();
    expect(roots()).toEqual(["hidden", "hidden"]);
    dialog(false);
    await settle();
    expect(roots()).toEqual(["", ""]);
  });

  it("is ignored where the browser does not know :modal", async () => {
    const query = document.querySelector.bind(document);
    vi.spyOn(document, "querySelector").mockImplementation(((sel: string) => {
      if (sel === ":modal") throw new SyntaxError("unknown pseudo-class");
      return query(sel);
    }) as typeof document.querySelector);
    await start([survey()]);
    expect(hosts()).toHaveLength(1);
  });
});

describe("screen readers", () => {
  it.each([["popup"], ["banner"]])("a %s announces its question once, politely, without taking the focus", async (format) => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    await start([format === "banner" ? banner() : survey()]);
    const live = $("[role=status]")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("How likely are you to recommend us?");
    expect(document.activeElement).toBe(outside);
  });

  it("a Modal has no live region: it takes the focus instead", async () => {
    await start([survey({ format: "modal" })]);
    expect($("[role=status]")).toBeNull();
  });
});

/** A controllable IntersectionObserver. */
function fakeViewport() {
  const observers: { cb: IntersectionObserverCallback; targets: Element[]; off: boolean }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      o: (typeof observers)[number];
      constructor(cb: IntersectionObserverCallback) {
        this.o = { cb, targets: [], off: false };
        observers.push(this.o);
      }
      observe(el: Element) {
        this.o.targets.push(el);
      }
      unobserve(el: Element) {
        this.o.targets = this.o.targets.filter((t) => t !== el);
      }
      disconnect() {
        this.o.off = true;
      }
    },
  );
  /** Scrolls every observed element (or only `only`) into (or out of) view. */
  return (ratio = 1, only?: Element) => {
    for (const o of [...observers]) {
      if (o.off) continue;
      const targets = o.targets.filter((t) => !only || t === only);
      if (!targets.length) continue;
      const entries = targets.map((target) => ({ target, isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: { height: ratio * 100 } }) as unknown as IntersectionObserverEntry);
      o.cb(entries, {} as IntersectionObserver);
    }
  };
}

describe("Embed", () => {
  it("mounts into an element, keeps its room invisibly and reports survey_viewed only when it is in the viewport", async () => {
    const scroll = fakeViewport();
    const slot = element("slot");
    const loookin = await start([embed()]);
    loookin.mountSurvey("inline", slot);
    const host = slot.querySelector("loookin-survey")!;
    expect(host).not.toBeNull();
    expect(inside(host, ".root")!.style.visibility).toBe("hidden");
    expect(inside(host, ".card")!.classList.contains("embed")).toBe(true);
    expect(events()).toEqual([]);

    scroll(0.1);
    await settle();
    expect(events()).toEqual([]);
    scroll(0.8);
    await settle();
    expect(events()).toEqual([
      ["inline", "survey_viewed"],
      ["inline", "survey_step_reached"],
    ]);
    expect(inside(host, ".root")!.style.visibility).toBe("");
    expect(inside(host, ".x")).toBeNull(); // no close button
  });

  it("mounts into a selector, and several at once", async () => {
    fakeViewport();
    element("a");
    const b = element("b");
    const loookin = await start([embed("one"), embed("two")]);
    loookin.mountSurvey("one", "#a");
    loookin.mountSurvey("two", b);
    expect(document.querySelectorAll("#a > loookin-survey, #b > loookin-survey")).toHaveLength(2);
  });

  it("leaves the target empty when the survey does not apply: not in the list, or another format", async () => {
    const slot = element("slot");
    const other = element("other");
    const loookin = await start([survey({ key: "pop", triggers: [] })]);
    loookin.mountSurvey("missing", slot);
    loookin.mountSurvey("pop", other);
    expect(slot.childNodes).toHaveLength(0);
    expect(other.childNodes).toHaveLength(0);
  });

  it("appears when the list arrives after the mount (identify after mountSurvey)", async () => {
    fakeViewport();
    const slot = element("slot");
    mockFetch();
    mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList([embed()]) : undefined));
    const loookin = await loadSdk();
    loookin.mountSurvey("inline", slot);
    loookin.init({ workspace: "acme", key: "pub_abc" });
    expect(slot.childNodes).toHaveLength(0);
    loookin.identify("u1");
    await settle();
    expect(slot.querySelector("loookin-survey")).not.toBeNull();
  });

  it("the returned function removes it and leaves the target as it was", async () => {
    fakeViewport();
    const slot = element("slot");
    slot.className = "panel";
    slot.append("Placeholder");
    const before = slot.outerHTML;
    const loookin = await start([embed()]);
    const remove = loookin.mountSurvey("inline", slot);
    expect(slot.childNodes).toHaveLength(2);
    remove();
    expect(slot.outerHTML).toBe(before);
    expect(() => remove()).not.toThrow();
  });

  it("is removed on reset and drawn again for the next identity the list has it for; stop removes it for good", async () => {
    fakeViewport();
    const slot = element("slot");
    const loookin = await start([embed()]);
    const remove = loookin.mountSurvey("inline", slot);
    expect(slot.childNodes).toHaveLength(1);
    loookin.reset();
    expect(slot.childNodes).toHaveLength(0);
    loookin.identify("u2");
    await settle();
    expect(slot.childNodes).toHaveLength(1);
    loookin.stop();
    expect(slot.childNodes).toHaveLength(0);
    expect(() => remove()).not.toThrow();
    expect(() => loookin.mountSurvey("inline", slot)).not.toThrow();
    expect(slot.childNodes).toHaveLength(0);
  });

  it("shows nothing and is not asked again when survey_viewed is refused", async () => {
    const scroll = fakeViewport();
    const slot = element("slot");
    mockFetch();
    mockSurveys((call) => {
      if (call.url.endsWith("/surveys")) return surveyList([embed()]);
      if (call.url.endsWith("/events")) return json(429, { error: "rate_limited" });
      return undefined;
    });
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", key: "pub_abc" });
    loookin.identify("u1");
    await settle();
    loookin.mountSurvey("inline", slot);
    scroll(1);
    await settle();
    expect(slot.childNodes).toHaveLength(0);
    history.pushState(null, "", "/again");
    await settle();
    expect(slot.childNodes).toHaveLength(0);
  });

  it("keeps its thank you in the page after an answer", async () => {
    const scroll = fakeViewport();
    const slot = element("slot");
    const loookin = await start([embed()]);
    loookin.mountSurvey("inline", slot);
    scroll(1);
    await settle();
    const host = slot.querySelector("loookin-survey")!;
    (Array.from(host.shadowRoot!.querySelectorAll("button")).find((b) => b.textContent === "9") as HTMLButtonElement).click();
    inside(host, ".next")!.click();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(slot.querySelector("loookin-survey")).not.toBeNull();
    expect(inside(host, ".done-icon")).not.toBeNull();
  });

  it("is not shown by showSurvey and never by triggers", async () => {
    fakeViewport();
    const loookin = await start([embed("inline", { triggers: [{ kind: "page_load", join: "and", pages: "any", hideOutside: false }] })]);
    expect(hosts()).toHaveLength(0);
    await expect(loookin.showSurvey("inline")).resolves.toBe(false);
  });
});

describe("Embed across mounts and re-renders", () => {
  const viewed = () => events().filter(([, e]) => e === "survey_viewed").length;
  const answer = async (slot: Element) => {
    const host = slot.querySelector("loookin-survey")!;
    (Array.from(host.shadowRoot!.querySelectorAll("button")).find((b) => b.textContent === "9") as HTMLButtonElement).click();
    inside(host, ".next")!.click();
    await settle();
  };

  it("a remount of a viewed key shows it again at once, without a second survey_viewed, in the same session", async () => {
    const scroll = fakeViewport();
    const slot = element("slot");
    const loookin = await start([embed()]);
    let remove = loookin.mountSurvey("inline", slot);
    scroll(1);
    await settle();
    expect(viewed()).toBe(1);
    remove();
    remove = loookin.mountSurvey("inline", slot);
    await settle();
    const host = slot.querySelector("loookin-survey")!;
    expect(inside(host, ".root")!.style.visibility).toBe("");
    await answer(slot);
    expect(viewed()).toBe(1);
    const sessions = new Set(surveyCalls.filter((c) => c.url.includes("/inline/")).map((c) => c.body.session));
    expect(sessions.size).toBe(1);
  });

  it("an answered key stays empty after unmount and remount", async () => {
    const scroll = fakeViewport();
    const slot = element("slot");
    const loookin = await start([embed()]);
    const remove = loookin.mountSurvey("inline", slot);
    scroll(1);
    await settle();
    await answer(slot);
    remove();
    loookin.mountSurvey("inline", slot);
    await settle();
    expect(slot.childNodes).toHaveLength(0);
  });

  it("the page re-rendering its target: drawn into the new element, no second view", async () => {
    const scroll = fakeViewport();
    element("slot");
    const loookin = await start([embed()]);
    loookin.mountSurvey("inline", "#slot");
    scroll(1);
    await settle();
    document.getElementById("slot")!.remove();
    const next = element("slot");
    history.pushState(null, "", "/page-2");
    await settle();
    expect(next.querySelector("loookin-survey")).not.toBeNull();
    expect(viewed()).toBe(1);
  });

  it("a selector that appears after an address change is found after the next frame or shortly after", async () => {
    fakeViewport();
    const loookin = await start([embed()]);
    loookin.mountSurvey("inline", "#later");
    history.pushState(null, "", "/settings");
    await vi.advanceTimersByTimeAsync(5);
    const later = element("later"); // the app renders the new page
    await vi.advanceTimersByTimeAsync(20);
    expect(later.querySelector("loookin-survey")).not.toBeNull();
  });

  it("an unresolved selector shares the throttled page watch, which stops once it resolved", async () => {
    fakeViewport();
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const loookin = await start([embed()]);
    loookin.mountSurvey("inline", "#later");
    await vi.advanceTimersByTimeAsync(1000);
    const calls = disconnect.mock.calls.length;
    const later = element("later");
    await vi.advanceTimersByTimeAsync(600);
    expect(later.querySelector("loookin-survey")).not.toBeNull();
    expect(disconnect.mock.calls.length).toBeGreaterThan(calls);
  });

  it("forgets a mount whose element left the page, and drops an embed whose element is gone when the observer reports", async () => {
    const scroll = fakeViewport();
    const slot = element("slot");
    const loookin = await start([embed()]);
    loookin.mountSurvey("inline", slot);
    slot.remove();
    scroll(1);
    await settle();
    expect(viewed()).toBe(0);
    history.pushState(null, "", "/b");
    await settle();
    document.body.append(slot);
    history.pushState(null, "", "/c");
    await settle();
    expect(slot.childNodes).toHaveLength(0);
  });
});

describe("mountSurvey never throws", () => {
  it.each([
    ["a null target", null],
    ["a number", 42],
    ["a selector that matches nothing", "#nowhere"],
    ["an invalid selector", "##"],
    ["a :has( selector", "div:has(p)"],
  ])("with %s", async (_, target) => {
    const loookin = await start([embed()]);
    let remove: (() => void) | undefined;
    expect(() => (remove = loookin.mountSurvey("inline", target as never))).not.toThrow();
    expect(typeof remove).toBe("function");
    expect(() => remove!()).not.toThrow();
    expect(hosts()).toHaveLength(0);
  });

  it.each([[undefined], [42], [""], [{}]])("with the key %j", async (key) => {
    const slot = element("slot");
    const loookin = await start([embed()]);
    expect(() => loookin.mountSurvey(key as never, slot)()).not.toThrow();
    expect(slot.childNodes).toHaveLength(0);
  });

  it("before init and with surveys: false", async () => {
    mockFetch();
    const loookin = await loadSdk();
    const slot = element("slot");
    expect(() => loookin.mountSurvey("inline", slot)()).not.toThrow();
    loookin.init({ workspace: "acme", key: "pub_abc", surveys: false });
    loookin.identify("u1");
    loookin.mountSurvey("inline", slot);
    await settle();
    expect(slot.childNodes).toHaveLength(0);
    expect(surveyCalls).toHaveLength(0);
  });
});

describe("types", () => {
  it("exports the mountSurvey types from the core entry", async () => {
    const { loookin } = await import("../src/browser");
    type Target = import("../src/browser").SurveyTarget;
    type Unmount = import("../src/browser").UnmountSurvey;
    expectTypeOf(loookin.mountSurvey).parameters.toEqualTypeOf<[string, Target]>();
    expectTypeOf(loookin.mountSurvey).returns.toEqualTypeOf<Unmount>();
    expectTypeOf<Target>().toEqualTypeOf<Element | string>();
  });
});
