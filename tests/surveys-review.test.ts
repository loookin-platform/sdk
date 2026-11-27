// @vitest-environment jsdom
// Hardening: a survey never traps, breaks or leaks into the host page.
import { describe, expect, it, vi } from "vitest";
import type { SdkSurvey } from "../src/surveys/types";
import { createTriggerWatch, RESCAN_MS, validSelector, VIEW_MAX } from "../src/surveys/triggers";
import { json, mockFetch, mockSurveys, surveyCalls, surveyList } from "./helpers";
import { loadSdk, setupPage } from "./page";
import { $, button, FakeChannel, rating, settle, setupSurveys, shadow, survey, text, thanks } from "./surveys-helpers";

setupPage();
setupSurveys();

const events = () => surveyCalls.filter((c) => c.url.endsWith("/events")).map((c) => c.body.event);
const responses = () => surveyCalls.filter((c) => c.url.endsWith("/responses"));

async function start(list: unknown[], init: Record<string, unknown> = {}, identify = true) {
  mockFetch();
  mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList(list) : undefined));
  const loookin = await loadSdk();
  loookin.init({ workspace: "acme", key: "pub_abc", ...init });
  if (identify) loookin.identify("u1", { company: "c1" });
  await settle();
  return loookin;
}

const manual = (extra: Partial<SdkSurvey> = {}) => survey({ triggers: [], ...extra });

describe("1. never trapped", () => {
  it("a failed send offers Close next to the retry, also without a close button", async () => {
    const loookin = await start([manual({ format: "modal", design: { ...survey().design, closeButton: false } })]);
    await loookin.showSurvey("nps");
    await settle();
    mockSurveys((call) => (call.url.endsWith("/responses") ? json(503, { error: "unavailable_now" }) : undefined));
    button("9")!.click();
    $(".next")!.click();
    await settle();
    expect($(".notice")?.textContent).toBe("We couldn't save your answer. Try again.");
    button("Close")!.click();
    expect(shadow()).toBeNull();
    expect(document.documentElement.getAttribute("style")).toBeNull();
  });
});

describe("2. errors leave nothing behind", () => {
  it("an error while drawing leaves no element, no scroll lock and no survey_viewed; showSurvey resolves to false", async () => {
    document.documentElement.removeAttribute("style");
    const loookin = await start([manual({ format: "modal" })]);
    vi.spyOn(document, "createElementNS").mockImplementation(() => {
      throw new Error("broken DOM");
    });
    await expect(loookin.showSurvey("nps")).resolves.toBe(false);
    expect(document.querySelector("loookin-survey")).toBeNull();
    expect(document.documentElement.getAttribute("style")).toBeNull();
    expect(events()).toEqual([]);
  });

  it("an error in an interaction closes the survey and never reaches the page", async () => {
    const loookin = await start([manual({ steps: [{ ...rating("s"), type: "choice", options: [{ key: "a", label: "A" }], multiple: false } as never, thanks()] })]);
    await loookin.showSurvey("nps");
    await settle();
    vi.spyOn(Element.prototype, "replaceChildren").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => button("A")!.click()).not.toThrow();
    expect(shadow()).toBeNull();
  });

  it.each([
    ["a title that is not text", { steps: [{ ...rating("s"), title: 42 }] }],
    ["a step that is not an object", { steps: ["nope"] }],
    ["options that are not objects", { steps: [{ ...rating("s"), type: "choice", options: ["x"], multiple: false }] }],
    ["branches that are not an array", { steps: [{ ...rating("s"), branches: { a: 1 } }] }],
    ["a branch without steps", { steps: [{ ...rating("s"), branches: [{ key: "b", label: "", min: 0, max: 5 }] }] }],
    ["no steps", { steps: [] }],
    ["a design that is not an object", { design: "red" }],
  ])("skips a definition with %s", async (_, broken) => {
    const loookin = await start([{ ...survey({ key: "bad" }), ...broken }]);
    expect(shadow()).toBeNull();
    await expect(loookin.showSurvey("bad")).resolves.toBe(false);
    expect(events()).toEqual([]);
  });

  it("showSurvey resolves to false without an identity", async () => {
    const loookin = await start([manual()], {}, false);
    await expect(loookin.showSurvey("nps")).resolves.toBe(false);
  });
});

describe("3. long answers", () => {
  it("shares the text limit among the text steps and shows a counter close to it", async () => {
    const loookin = await start([manual({ steps: [text("a"), text("b"), thanks()] })]);
    await loookin.showSurvey("nps");
    await settle();
    const field = $("input") as HTMLInputElement;
    expect(field.maxLength).toBe(9000);
    expect($(".count")!.hidden).toBe(true);
    field.value = "x".repeat(8200);
    field.dispatchEvent(new Event("input"));
    expect($(".count")!.hidden).toBe(false);
    expect($(".count")!.textContent).toBe("8200 / 9000");
  });

  it.each([
    ["body_too_large", 413, "Your answer is too long to send."],
    ["invalid_answer", 400, "We couldn't save your answer."],
  ])("ends with a message and Close on %s, without retrying", async (code, status, message) => {
    const loookin = await start([manual({ steps: [text("a"), thanks()] })]);
    await loookin.showSurvey("nps");
    await settle();
    mockSurveys((call) => (call.url.endsWith("/responses") ? json(status, { error: code }) : undefined));
    $(".next")!.click();
    await settle();
    expect($(".title")?.textContent).toBe(message);
    expect($(".next")?.textContent).toBe("Close");
    $(".next")!.click();
    expect(shadow()).toBeNull();
    expect(responses()).toHaveLength(1);
  });

  it("does not send a body over the limit at all", async () => {
    const { sendResponse } = await import("../src/surveys/client");
    mockFetch();
    const outcome = await sendResponse("https://acme.loookin.com", "pub_abc", "nps", {
      identity: { user: "u1" },
      versionId: "v1",
      session: "s".repeat(20),
      submissionId: "t".repeat(20),
      answers: [{ stepKey: "a", text: "é".repeat(40_000) }],
    });
    expect(outcome).toBe("body_too_large");
    expect(responses()).toHaveLength(0);
  });
});

describe("4. element_view", () => {
  function fakeObserver() {
    const observed: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {
          observed.length = 0;
        }
      },
    );
    return observed;
  }

  it("refuses :has( selectors", () => {
    expect(validSelector("main:has(.pricing)")).toBe(false);
    expect(validSelector(".pricing")).toBe(true);
  });

  it("observes at most 20 elements per selector and rescans at most once per 500 ms, with a trailing run", async () => {
    vi.useFakeTimers();
    const observed = fakeObserver();
    for (let i = 0; i < 30; i++) document.body.append(Object.assign(document.createElement("div"), { className: "card" }));
    const watch = createTriggerWatch(new Set(), () => {}, () => 0);
    watch.watch([survey({ triggers: [{ kind: "element_view", join: "and", selector: ".card" }] })]);
    expect(observed).toHaveLength(VIEW_MAX);

    const scans = vi.spyOn(document, "querySelectorAll");
    for (let i = 0; i < 10; i++) {
      document.body.append(document.createElement("span"));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(scans.mock.calls.length).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(RESCAN_MS);
    expect(scans.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(scans.mock.calls.length).toBeLessThanOrEqual(2);
    watch.stop();
  });

  it("stops watching page mutations once every view selector was seen", () => {
    let report: (entries: Partial<IntersectionObserverEntry>[]) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: typeof report) {
          report = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const el = Object.assign(document.createElement("section"), { className: "pricing" });
    document.body.append(el);
    const watch = createTriggerWatch(new Set(), () => {}, () => 0);
    watch.watch([survey({ triggers: [{ kind: "element_view", join: "and", selector: ".pricing" }] })]);
    expect(disconnect).not.toHaveBeenCalled();
    report([{ isIntersecting: true, target: el }]);
    expect(disconnect).toHaveBeenCalled();
    watch.stop();
  });
});

describe("5. a lost host element", () => {
  it("counts as closed: scrolling comes back and the next survey may show", async () => {
    document.documentElement.removeAttribute("style");
    await start([survey({ key: "first", format: "modal" }), survey({ key: "second" })]);
    expect(document.documentElement.style.overflow).toBe("hidden");
    document.body.replaceChildren(); // a framework replaced the body
    history.pushState(null, "", "/next");
    await settle();
    expect(document.documentElement.getAttribute("style")).toBeNull();
    expect(document.querySelectorAll("loookin-survey")).toHaveLength(1); // "second"
  });
});

describe("6. anonymous mode remembers", () => {
  const anonymous = { anonymous: true };

  it.each([
    ["shown, showAgain off", false, "close", false],
    ["shown, showAgain on", true, "leave", true],
    ["dismissed", true, "close", false],
    ["completed", true, "answer", false],
  ] as const)("%s: shown again on the next visit = %s", async (_, showAgain, act, again) => {
    await start([survey({ showAgain, steps: [rating("s"), thanks()] })], anonymous, false);
    expect(shadow()).not.toBeNull();
    if (act === "close") button("Close")!.click();
    if (act === "answer") {
      button("9")!.click();
      $(".next")!.click();
      await settle();
    }
    expect(localStorage.getItem("loookin_surveys")).toContain('"nps"');

    document.body.replaceChildren();
    await start([survey({ showAgain, steps: [rating("s"), thanks()] })], anonymous, false); // the next page load
    expect(!!shadow()).toBe(again);
  });

  it("keeps at most 50 surveys", async () => {
    const { remember, MEMORY_MAX } = await import("../src/surveys/memory");
    for (let i = 0; i < 60; i++) {
      vi.setSystemTime(Date.now() + 1000);
      remember(`s${i}`, "shown");
    }
    const store = JSON.parse(localStorage.getItem("loookin_surveys")!);
    expect(Object.keys(store)).toHaveLength(MEMORY_MAX);
    expect(store.s59).toBeDefined();
    expect(store.s0).toBeUndefined();
  });

  it("writes nothing to storage outside anonymous mode, and stop() removes the memory", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    const loookin = await start([survey()]);
    button("Close")!.click();
    expect(set).not.toHaveBeenCalled();
    localStorage.setItem("loookin_surveys", "{}");
    loookin.stop();
    expect(localStorage.getItem("loookin_surveys")).toBeNull();
  });
});

describe("8 to 10. navigation and time", () => {
  it("does not hide a survey shown through an or branch that does not depend on the page", async () => {
    history.replaceState(null, "", "/settings");
    const loookin = await start([
      survey({
        triggers: [
          { kind: "page_load", join: "and", pages: [{ op: "starts_with", value: "/orders" }], hideOutside: true },
          { kind: "event", join: "or", event: "upgraded" },
        ],
      }),
    ]);
    loookin.track("upgraded");
    await settle();
    expect(shadow()).not.toBeNull();
    history.pushState(null, "", "/billing");
    await settle();
    expect(shadow()).not.toBeNull();
  });

  it("a replaceState of the query only does not restart time on page", async () => {
    await start([survey({ triggers: [{ kind: "time_on_page", join: "and", seconds: 10 }] })]);
    await vi.advanceTimersByTimeAsync(6_000);
    history.replaceState(null, "", "/?q=a");
    history.replaceState(null, "", "/?q=ab");
    await vi.advanceTimersByTimeAsync(4_100);
    expect(shadow()).not.toBeNull();
  });

  it("counts time on page from the page load, not from when the renderer loaded", async () => {
    mockFetch();
    mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList([survey({ triggers: [{ kind: "time_on_page", join: "and", seconds: 5 }] })]) : undefined));
    const loookin = await loadSdk(); // the page loads
    loookin.init({ workspace: "acme", key: "pub_abc" });
    await vi.advanceTimersByTimeAsync(3_000);
    loookin.identify("u1"); // the list and the renderer arrive 3 s later
    await settle();
    expect(shadow()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(shadow()).not.toBeNull();
  });
});

describe("12 to 14. placement", () => {
  it("lets the browser pick the direction of the text", async () => {
    await start([survey()]);
    expect($(".card")!.getAttribute("dir")).toBe("auto");
  });

  it.each([["top layer"], ["fixed fallback"]])("%s: the survey shows, a Modal keeps its backdrop and focus", async (mode) => {
    const show = vi.fn();
    if (mode === "top layer") vi.stubGlobal("HTMLElement", HTMLElement), Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: show });
    try {
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      await start([survey({ format: "modal" })]);
      const host = document.querySelector("loookin-survey")!;
      expect(host.getAttribute("popover")).toBe(mode === "top layer" ? "manual" : null);
      expect(show).toHaveBeenCalledTimes(mode === "top layer" ? 1 : 0);
      expect($(".overlay")!.classList.contains("backdrop")).toBe(true);
      expect(shadow()!.activeElement).not.toBeNull();
      button("Close")!.click();
      expect(document.activeElement).toBe(outside);
    } finally {
      delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover;
    }
  });

  it("closes at once when the styles did not apply, leaving the page as it was", async () => {
    document.documentElement.removeAttribute("style");
    const real = window.getComputedStyle;
    const computed = vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      return (el as Element).classList?.contains("overlay") ? ({ ...style, position: "static" } as CSSStyleDeclaration) : style;
    });
    const loookin = await start([manual({ format: "modal" })]);
    await expect(loookin.showSurvey("nps")).resolves.toBe(false);
    expect(computed.mock.calls.some(([el]) => (el as Element).classList?.contains("overlay"))).toBe(true);
    expect(document.querySelector("loookin-survey")).toBeNull();
    expect(document.documentElement.getAttribute("style")).toBeNull();
    expect(events()).toEqual([]);
  });
});

describe("15 to 17. measuring", () => {
  it("closing while the response is on its way is not a dismissal", async () => {
    const loookin = await start([manual({ steps: [rating("s"), thanks()] })]);
    await loookin.showSurvey("nps");
    await settle();
    mockSurveys((call) => (call.url.endsWith("/responses") ? new Promise<Response>(() => {}) : undefined));
    button("9")!.click();
    $(".next")!.click();
    await settle();
    button("Close")!.click();
    await settle();
    expect(events()).not.toContain("survey_dismissed");
  });

  it("closes the BroadcastChannel on pagehide and opens a new one on pageshow", async () => {
    await start([survey()]);
    const first = FakeChannel.all.find((c) => c.name === "loookin-surveys")!;
    window.dispatchEvent(new Event("pagehide"));
    expect(first.closed).toBe(true);
    window.dispatchEvent(new Event("pageshow"));
    expect(FakeChannel.all.filter((c) => c.name === "loookin-surveys" && !c.closed)).toHaveLength(1);
  });

  it.each([[429], [500]])("shows nothing when survey_viewed is answered %s, and sends nothing more", async (status) => {
    mockFetch();
    mockSurveys((call) => {
      if (call.url.endsWith("/surveys")) return surveyList([manual()]);
      if (call.url.endsWith("/events")) return json(status, { error: "rate_limited" });
      return undefined;
    });
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", key: "pub_abc" });
    loookin.identify("u1");
    await settle();
    await expect(loookin.showSurvey("nps")).resolves.toBe(false);
    await settle();
    expect(document.querySelector("loookin-survey")).toBeNull();
    expect(events()).toEqual(["survey_viewed"]);
  });
});
