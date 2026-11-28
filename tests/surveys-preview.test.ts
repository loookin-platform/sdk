// @vitest-environment jsdom
// mountSurveyPreview (0.3.1): one definition drawn into an element, with the live renderer and no side effects.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { mountSurveyPreview, type SurveyDefinition, type SurveyPreview, type SurveyPreviewOptions } from "../src/surveys";
import { CSS, previewCss } from "../src/surveys/render/styles";
import type { SdkSurvey } from "../src/surveys/types";
import { choice, message, rating, survey, text, thanks } from "./surveys-helpers";

/** A ResizeObserver that tests drive by hand (jsdom has none). */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets: Element[] = [];
  disconnected = false;
  constructor(readonly fn: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  static resize(width: number) {
    for (const ro of FakeResizeObserver.all) {
      if (ro.disconnected) continue;
      ro.fn(ro.targets.map((target) => ({ target, contentRect: { width, height: 600 } }) as unknown as ResizeObserverEntry), ro as unknown as ResizeObserver);
    }
  }
}

let fetchSpy: ReturnType<typeof vi.fn>;
let target: HTMLElement;
const handles: SurveyPreview[] = [];

function mount(definition: unknown, options?: SurveyPreviewOptions, el: Element = target) {
  const handle = mountSurveyPreview(el, definition as SdkSurvey, options);
  handles.push(handle);
  return handle;
}

function sized(el: Element, width: number, height = 600) {
  const r = { top: 50, left: 30, width, height, bottom: 50 + height, right: 30 + width, x: 30, y: 50 };
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ ...r, toJSON: () => r } as DOMRect);
  // Layout sizes, as a laid-out page would report them.
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: height });
}

function rect(r: { top: number; left: number; width: number; height: number }) {
  const full = { ...r, bottom: r.top + r.height, right: r.left + r.width, x: r.left, y: r.top };
  return { ...full, toJSON: () => full } as DOMRect;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  document.head.replaceChildren();
  document.documentElement.removeAttribute("style");
  FakeResizeObserver.all = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  // Any request fails the test, also one made and swallowed inside the SDK.
  fetchSpy = vi.fn(() => {
    throw new Error("fetch must not be called by a preview");
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("BroadcastChannel", vi.fn());
  vi.stubGlobal("navigator", { ...navigator, sendBeacon: vi.fn() });
  vi.spyOn(Storage.prototype, "setItem");
  vi.spyOn(Storage.prototype, "removeItem");
  target = document.createElement("div");
  target.id = "preview";
  target.className = "editor-canvas";
  target.setAttribute("data-x", "1");
  target.append(document.createElement("p"), "placeholder");
  document.body.append(target);
  sized(target, 1000);
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(Storage.prototype.setItem).not.toHaveBeenCalled();
  expect(Storage.prototype.removeItem).not.toHaveBeenCalled();
  expect(BroadcastChannel).not.toHaveBeenCalled();
  expect(navigator.sendBeacon).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const host = () => target.querySelector<HTMLElement>("loookin-survey");
const root = () => host()?.shadowRoot?.querySelector<HTMLElement>(".root") ?? null;
const $ = (selector: string) => host()?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
const $$ = (selector: string) => Array.from(host()?.shadowRoot?.querySelectorAll<HTMLElement>(selector) ?? []);
const button = (label: string) => $$("button").find((b) => b.textContent === label || b.getAttribute("aria-label") === label) ?? null;
const title = () => $(".title")?.textContent;
/** The first step's title, with the mark of a required step. */
const FIRST = "How likely are you to recommend us? *";

const flow = (extra: Partial<SdkSurvey> = {}) =>
  survey({ key: "flow", steps: [rating("s_1"), text("s_2", "Why?"), thanks("s_end", "Thanks!")], ...extra });
const formats: [string, Partial<SdkSurvey>][] = [
  ["popup", {}],
  ["modal", { format: "modal" }],
  ["banner", { format: "banner", design: { ...survey().design, position: "top" } }],
  ["tooltip", { format: "tooltip", design: { ...survey().design, position: undefined, anchor: "#help" } }],
  ["embed", { format: "embed", triggers: [], design: { ...survey().design, closeButton: undefined, position: undefined } }],
];

describe("mountSurveyPreview", () => {
  it.each(formats)("draws a %s inside the target and nowhere else", (format, extra) => {
    const bodyBefore = Array.from(document.body.children);
    mount(flow(extra));
    expect(Array.from(document.body.children)).toEqual(bodyBefore);
    expect(document.head.children).toHaveLength(0);
    expect(target.children).toHaveLength(1);
    expect(host()).not.toBeNull();
    expect(host()!.style.getPropertyValue("position")).toBe("relative");
    expect(document.querySelector("[popover]")).toBeNull();
    expect(document.documentElement.getAttribute("style")).toBeNull();
    expect($(`.card.${format}`)).not.toBeNull();
    expect(root()!.style.getPropertyValue("visibility")).toBe("");
    expect($(".test")).toBeNull();
  });

  it("draws a Tooltip next to an anchor of its own, and an Embed in a block of its own", () => {
    mount(flow(formats[3]![1]));
    expect($(".pv-anchor")).not.toBeNull();
    expect($(".tooltip")).not.toBeNull();
    handles.pop()!.destroy();
    mount(flow(formats[4]![1]));
    expect($(".pv-block > .card.embed")).not.toBeNull();
  });

  it("never shows the Test label, sends nothing and starts no triggers, also for a test run", async () => {
    mount(flow({ isTest: true, triggers: [{ kind: "time_on_page", join: "and", seconds: 1 }] }));
    expect($(".test")).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(target.querySelectorAll("loookin-survey")).toHaveLength(1);
  });

  it("walks the flow, tells each step, and stays on the thank you", async () => {
    const onStep = vi.fn();
    mount(flow(), { onStep });
    expect(onStep.mock.calls).toEqual([["s_1"]]);
    button("9")!.click();
    button("Next")!.click();
    expect(title()).toBe("Why?");
    button("Next")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(title()).toBe("Thanks!");
    expect(onStep.mock.calls).toEqual([["s_1"], ["s_2"], ["s_end"]]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(title()).toBe("Thanks!");
  });

  it("follows a branch", () => {
    const branched = { ...choice("s_1", ["a", "b"]), branches: [{ key: "br", label: "A", optionKeys: ["a"], steps: [message("s_a", "Branch A")] }] } as never;
    mount(flow({ steps: [branched, thanks()] }));
    button("A")!.click();
    button("Next")!.click();
    expect(title()).toBe("Branch A");
  });

  it("restarts at the first step on Close, and on Escape, without leaving the target", async () => {
    const onStep = vi.fn();
    mount(flow(), { onStep });
    button("9")!.click();
    button("Next")!.click();
    button("Close")!.click();
    expect(title()).toBe(FIRST);
    expect(target.querySelectorAll("loookin-survey")).toHaveLength(1);
    expect(onStep.mock.calls.map(([k]) => k)).toEqual(["s_1", "s_2", "s_1"]);

    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    button("9")!.click();
    button("Next")!.click();
    $(".card")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(title()).toBe(FIRST);
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outside);
  });

  it("restarts from the thank you on Close", async () => {
    mount(flow({ steps: [message("s_1"), thanks()] }));
    button("Next")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(title()).toBe("Thank you");
    button("Close")!.click();
    expect(title()).toBe("Hello");
  });

  it("a Modal neither moves the focus, nor traps it, nor locks scrolling, and its backdrop is inside the target", () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    mount(flow({ format: "modal" }));
    expect(document.activeElement).toBe(outside);
    expect(document.documentElement.getAttribute("style")).toBeNull();
    expect($(".overlay.backdrop")).not.toBeNull();
    expect($(".card")!.hasAttribute("aria-modal")).toBe(false);
  });

  it("starts at the step it is given, also inside a branch and at the thank you", () => {
    mount(flow(), { step: "s_2" });
    expect(title()).toBe("Why?");
    handles.pop()!.destroy();
    const branched = { ...rating("s_1"), branches: [{ key: "low", label: "Low", min: 0, max: 6, steps: [message("s_low", "Sorry")] }] } as never;
    mount(flow({ steps: [branched, thanks()] }), { step: "s_low" });
    expect(title()).toBe("Sorry");
    handles.pop()!.destroy();
    mount(flow(), { step: "s_end" });
    expect(title()).toBe("Thanks!");
    expect($(".next")).toBeNull();
    handles.pop()!.destroy();
    mount(flow(), { step: "missing" });
    expect(title()).toBe(FIRST);
  });

  it("can be drawn without interaction", () => {
    mount(flow(), { interactive: false });
    expect(root()!.hasAttribute("inert")).toBe(true);
  });

  it("narrow: true uses the narrow layout of each format whatever the width", () => {
    mount(flow(), { narrow: true });
    expect(root()!.classList.contains("narrow")).toBe(true);
    handles.pop()!.destroy();
    mount(flow(formats[2]![1]), { narrow: true });
    expect($(".card")!.classList.contains("stack")).toBe(true);
  });

  it("otherwise follows the target's width, not the window's, and reacts to resizes of the target", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    mount(flow(formats[2]![1]));
    expect(root()!.classList.contains("narrow")).toBe(false);
    expect($(".card")!.classList.contains("row")).toBe(true);
    button("7")!.click();
    FakeResizeObserver.resize(500);
    expect(root()!.classList.contains("narrow")).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect($(".card")!.classList.contains("stack")).toBe(true);
    expect(button("7")!.getAttribute("aria-pressed")).toBe("true");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  });

  it("a narrow target draws the narrow layout", () => {
    sized(target, 360);
    mount(flow());
    expect(root()!.classList.contains("narrow")).toBe(true);
  });

  it("update keeps the step on screen when the new definition has it, else starts over", () => {
    const onStep = vi.fn();
    const preview = mount(flow(), { onStep });
    button("9")!.click();
    button("Next")!.click();
    preview.update(flow({ steps: [rating("s_1"), text("s_2", "Why not?"), thanks("s_end")] }), { onStep });
    expect(title()).toBe("Why not?");
    expect(target.querySelectorAll("loookin-survey")).toHaveLength(1);
    expect(onStep.mock.calls.map(([k]) => k)).toEqual(["s_1", "s_2"]);
    preview.update(flow({ format: "modal" }), { onStep });
    expect($(".card.modal")).not.toBeNull();
    expect(title()).toBe("Why?");
    preview.update(flow({ steps: [message("s_x", "New")] }), { onStep });
    expect(title()).toBe("New");
    preview.update(flow(), { onStep, step: "s_end" });
    expect(title()).toBe("Thanks!");
  });

  it("update with a definition it cannot draw shows nothing until a good one comes", () => {
    const preview = mount(flow());
    preview.update({ ...flow(), steps: [] });
    expect(host()).toBeNull();
    preview.update(flow());
    expect(title()).toBe(FIRST);
  });

  it("destroy gives the target back exactly as it was", () => {
    const children = Array.from(target.childNodes);
    const markup = target.outerHTML;
    const preview = mount(flow({ format: "modal" }));
    expect(target.childNodes).toHaveLength(1);
    preview.destroy();
    expect(Array.from(target.childNodes)).toEqual(children);
    expect(target.outerHTML).toBe(markup);
    expect(FakeResizeObserver.all.every((ro) => ro.disconnected)).toBe(true);
    preview.destroy();
    preview.update(flow());
    expect(target.outerHTML).toBe(markup);
  });

  it.each([
    ["a malformed definition", { ...survey(), steps: [{ key: "x", type: "video" }] }],
    ["no steps", { ...survey(), steps: [] }],
    ["an unsupported format", { ...survey(), format: "fullscreen" }],
    ["a newer schema", { ...survey(), schema: 99 }],
    ["not an object", "popup"],
    ["nothing", undefined],
  ])("renders nothing and returns no-ops for %s", (_, definition) => {
    const markup = target.outerHTML;
    const preview = mount(definition);
    expect(target.outerHTML).toBe(markup);
    expect(() => preview.update(flow())).not.toThrow();
    expect(() => preview.destroy()).not.toThrow();
    expect(target.outerHTML).toBe(markup);
  });

  it("never throws for a bad target", () => {
    for (const bad of [null, undefined, "#preview", {}, document.createTextNode("x")]) {
      expect(() => mount(flow(), {}, bad as unknown as Element).destroy()).not.toThrow();
    }
  });

  it("previews a draft without the fields only the live flow reads", () => {
    const { key: _k, versionId: _v, triggers: _t, ...draft } = flow();
    mount(draft);
    expect(title()).toBe(FIRST);
  });

  it("keeps text as text and validates the Design as live rendering does", () => {
    mount(flow({ steps: [message("s_1", "<img src=x onerror=alert(1)>")], design: { ...survey().design, accentColor: "red;background:url(x)" } }));
    expect(title()).toBe("<img src=x onerror=alert(1)>");
    expect($("img")).toBeNull();
    expect(root()!.style.getPropertyValue("--cp-accent")).toBe("#006eff");
  });

  it("does not load a web font unless asked", () => {
    mount(flow({ design: { ...survey().design, font: "roboto" } }));
    expect(document.head.querySelector("link")).toBeNull();
  });

  it("a throwing onStep stays out of the preview", () => {
    mount(flow(), { onStep: () => { throw new Error("tool"); } });
    expect(() => {
      button("9")!.click();
      button("Next")!.click();
    }).not.toThrow();
    expect(title()).toBe("Why?");
  });

  it("has a stylesheet of its own: no viewport units, the narrow layout by class; the live one is untouched", () => {
    const css = previewCss();
    expect(css).not.toMatch(/\dv[hw]\b/);
    expect(css).not.toContain("@media");
    expect(css).toContain(".narrow .overlay{align-items:flex-end;padding:0}");
    expect(CSS).toContain("@media (max-width:640px){");
    expect(CSS).not.toContain(".narrow");
  });

  it("places a Tooltip in layout pixels when the target is scaled by a transform", () => {
    // The preview is 1000 x 600 in layout, drawn at half size on screen.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("root") ? 1000 : this.classList.contains("tooltip") ? 320 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("root") ? 600 : this.classList.contains("tooltip") ? 100 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("root")) return rect({ top: 50, left: 30, width: 500, height: 300 });
      if (this.classList.contains("pv-anchor")) return rect({ top: 62, left: 270, width: 40, height: 15 });
      return rect({ top: 0, left: 0, width: 0, height: 0 });
    });
    mount(flow(formats[3]![1]));
    // Anchor in layout pixels: top 24, bottom 54, left 480, width 80; the card goes 10 px below, centred.
    expect($(".tooltip")!.style.top).toBe("64px");
    expect($(".tooltip")!.style.left).toBe("360px");
  });

  it("picks the layout from the target's layout width, not its on-screen width", () => {
    sized(target, 1000);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect({ top: 0, left: 0, width: 400, height: 240 }));
    mount(flow(formats[2]![1]));
    expect(root()!.classList.contains("narrow")).toBe(false);
    expect($(".card")!.classList.contains("row")).toBe(true);
  });

  it("a second mount on the same target replaces the first; both handles then leave the target as it was", () => {
    const children = Array.from(target.childNodes);
    const markup = target.outerHTML;
    const a = mount(flow());
    const b = mount(flow({ format: "modal" }));
    expect(target.querySelectorAll("loookin-survey")).toHaveLength(1);
    expect($(".card.modal")).not.toBeNull();
    a.update(flow({ format: "banner" }));
    expect($(".card.modal")).not.toBeNull();
    a.destroy();
    expect($(".card.modal")).not.toBeNull();
    b.destroy();
    expect(Array.from(target.childNodes)).toEqual(children);
    expect(target.outerHTML).toBe(markup);
    expect(document.querySelectorAll("loookin-survey")).toHaveLength(0);
  });

  it("update without options keeps the previous ones; options given replace only their keys", () => {
    const onStep = vi.fn();
    const preview = mount(flow(), { onStep, narrow: true, interactive: false });
    preview.update(flow({ steps: [message("s_x", "New")] }));
    expect(root()!.classList.contains("narrow")).toBe(true);
    expect(root()!.hasAttribute("inert")).toBe(true);
    expect(onStep.mock.calls.map(([k]) => k)).toEqual(["s_1", "s_x"]);
    preview.update(flow({ steps: [message("s_y", "Newer")] }), { interactive: true });
    expect(root()!.hasAttribute("inert")).toBe(false);
    expect(root()!.classList.contains("narrow")).toBe(true);
    expect(onStep.mock.calls.map(([k]) => k)).toEqual(["s_1", "s_x", "s_y"]);
  });

  it("a target off the page or without size is drawn once it has one, with the layout of its first width", () => {
    const detached = document.createElement("div");
    const onStep = vi.fn();
    mount(flow(formats[2]![1]), { onStep }, detached);
    expect(detached.querySelector("loookin-survey")).toBeNull();
    expect(onStep).not.toHaveBeenCalled();
    FakeResizeObserver.resize(0);
    expect(detached.querySelector("loookin-survey")).toBeNull();
    document.body.append(detached);
    FakeResizeObserver.resize(1200);
    const card = detached.querySelector("loookin-survey")!.shadowRoot!.querySelector(".card")!;
    expect(card.classList.contains("row")).toBe(true);
    expect(onStep.mock.calls).toEqual([["s_1"]]);

    const narrowTarget = document.createElement("div");
    document.body.append(narrowTarget); // on the page, no width yet
    mount(flow(), {}, narrowTarget);
    expect(narrowTarget.querySelector("loookin-survey")).toBeNull();
    FakeResizeObserver.resize(639); // just under the breakpoint: narrow from the first frame
    expect(narrowTarget.querySelector("loookin-survey")!.shadowRoot!.querySelector(".root")!.classList.contains("narrow")).toBe(true);
  });

  it("exports its types from the surveys entry", () => {
    expectTypeOf(mountSurveyPreview).parameters.toEqualTypeOf<[Element, SurveyDefinition, SurveyPreviewOptions?]>();
    expectTypeOf(mountSurveyPreview).returns.toEqualTypeOf<SurveyPreview>();
  });
});
