// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTriggerWatch, evaluateTriggers, pagesMatch, ruleMatches } from "../src/surveys/triggers";
import type { Trigger } from "../src/surveys/types";
import { survey } from "./surveys-helpers";

const T = (value: boolean, join: "and" | "or" = "and") => ({ kind: "event", join, event: value ? "yes" : "no" }) as Trigger;
const holds = (t: Trigger) => t.kind === "event" && t.event === "yes";
const at = (url: string) => history.replaceState(null, "", url);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
  document.body.replaceChildren();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  at("/");
});

describe("and / or", () => {
  it.each([
    ["a", [T(true)], true],
    ["a and b", [T(true), T(false)], false],
    ["a or b", [T(false), T(true, "or")], true],
    // and binds tighter: (true and false) or true
    ["a and b or c", [T(true), T(false), T(true, "or")], true],
    // false or (true and false)
    ["a or b and c", [T(false), T(true, "or"), T(false)], false],
    // (false and true) or (true and true)
    ["a and b or c and d", [T(false), T(true), T(true, "or"), T(true)], true],
    // the join of the first trigger is ignored
    ["or a", [T(true, "or")], true],
    ["none", [], false],
  ])("%s", (_, triggers, expected) => {
    expect(evaluateTriggers(triggers, holds)).toBe(expected);
  });

  it("treats a trigger whose test throws as false, without throwing", () => {
    const boom = () => {
      throw new Error("bad");
    };
    expect(() => evaluateTriggers([T(true)], boom)).not.toThrow();
    expect(evaluateTriggers([T(true), T(true, "or")], (t) => (t === undefined ? true : boom()))).toBe(false);
  });
});

describe("page rules", () => {
  const loc = (href: string) => {
    const u = new URL(href);
    return { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash };
  };
  it.each([
    [{ op: "contains", value: "/orders" }, "https://app.test/shop/orders/12?x=1", true],
    [{ op: "equals", value: "/orders" }, "https://app.test/orders?x=1", true],
    [{ op: "equals", value: "/orders" }, "https://app.test/orders/12", false],
    [{ op: "starts_with", value: "/orders" }, "https://app.test/orders/12", true],
    [{ op: "starts_with", value: "/orders" }, "https://app.test/shop/orders", false],
    [{ op: "equals", value: "/orders?tab=open" }, "https://app.test/orders?tab=open", true],
    [{ op: "contains", value: "#help" }, "https://app.test/orders#help", true],
    [{ op: "starts_with", value: "https://app.test/orders" }, "https://app.test/orders/1", true],
    [{ op: "contains", value: "" }, "https://app.test/", false],
    [{ op: "unknown", value: "/" }, "https://app.test/", false],
  ] as const)("%j on %s", (rule, href, expected) => {
    expect(ruleMatches(rule as never, loc(href))).toBe(expected);
  });

  it("matches any page, and any one of several rules", () => {
    expect(pagesMatch("any", loc("https://app.test/x"))).toBe(true);
    expect(pagesMatch([{ op: "equals", value: "/a" }, { op: "equals", value: "/b" }], loc("https://app.test/b"))).toBe(true);
    expect(pagesMatch([], loc("https://app.test/b"))).toBe(false);
  });
});

describe("the watch", () => {
  const events = new Set<string>();
  /** When the page "navigated": time on page counts from here. */
  let t0 = 0;
  const since = () => t0;
  beforeEach(() => {
    events.clear();
    t0 = Date.now();
  });

  it("follows the address for page_load", () => {
    const s = survey({ triggers: [{ kind: "page_load", join: "and", pages: [{ op: "starts_with", value: "/orders" }], hideOutside: true }] });
    const watch = createTriggerWatch(events, () => {}, since);
    watch.watch([s]);
    at("/home");
    expect(watch.satisfied(s)).toBe(false);
    at("/orders/7");
    watch.address();
    expect(watch.satisfied(s)).toBe(true);
    watch.stop();
  });

  it("counts an event from the set of tracked names", () => {
    const s = survey({ triggers: [{ kind: "event", join: "and", event: "order_completed" }] });
    const watch = createTriggerWatch(events, () => {}, since);
    expect(watch.satisfied(s)).toBe(false);
    events.add("order_completed");
    expect(watch.satisfied(s)).toBe(true);
    expect(watch.satisfied(survey({ triggers: [{ kind: "event", join: "and", event: "" }] }))).toBe(false);
  });

  it("calls back when time on page is reached, counted from the last address change", async () => {
    const changed = vi.fn();
    const s = survey({ triggers: [{ kind: "time_on_page", join: "and", seconds: 10 }] });
    const watch = createTriggerWatch(events, changed, since);
    watch.watch([s]);
    await vi.advanceTimersByTimeAsync(6_000);
    t0 = Date.now(); // a navigation: time on page starts again
    watch.address();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(watch.satisfied(s)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_100);
    expect(changed).toHaveBeenCalled();
    expect(watch.satisfied(s)).toBe(true);
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one delegated click listener, only for selectors from the definitions", () => {
    const add = vi.spyOn(document, "addEventListener");
    const changed = vi.fn();
    document.body.append(Object.assign(document.createElement("button"), { id: "buy" }), Object.assign(document.createElement("button"), { id: "other" }));
    const a = survey({ key: "a", triggers: [{ kind: "click", join: "and", selector: "#buy" }] });
    const b = survey({ key: "b", triggers: [{ kind: "click", join: "and", selector: "#buy" }] });
    const watch = createTriggerWatch(events, changed, since);
    watch.watch([a, b]);
    expect(add.mock.calls.filter(([type]) => type === "click")).toHaveLength(1);

    document.getElementById("other")!.click();
    expect(changed).not.toHaveBeenCalled();
    document.getElementById("buy")!.click();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(watch.satisfied(a)).toBe(true);
    watch.address(); // a click counts until the address changes
    expect(watch.satisfied(a)).toBe(false);
    watch.stop();
  });

  it("disables a trigger with an invalid selector and never throws", () => {
    const add = vi.spyOn(document, "addEventListener");
    const s = survey({
      triggers: [
        { kind: "click", join: "and", selector: "##not a selector[" },
        { kind: "element_view", join: "or", selector: ":::" },
      ],
    });
    const watch = createTriggerWatch(events, () => {}, since);
    expect(() => watch.watch([s])).not.toThrow();
    expect(add).not.toHaveBeenCalledWith("click", expect.anything(), true);
    expect(() => document.body.click()).not.toThrow();
    expect(watch.satisfied(s)).toBe(false);
  });

  it("observes elements for element_view and counts one that becomes visible", () => {
    const observed: Element[] = [];
    let report: (entries: Partial<IntersectionObserverEntry>[]) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: Partial<IntersectionObserverEntry>[]) => void) {
          report = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {}
      },
    );
    const el = Object.assign(document.createElement("section"), { className: "pricing" });
    document.body.append(el);
    const changed = vi.fn();
    const s = survey({ triggers: [{ kind: "element_view", join: "and", selector: ".pricing" }] });
    const watch = createTriggerWatch(events, changed, since);
    watch.watch([s]);
    expect(observed).toEqual([el]);
    report([{ isIntersecting: true, target: el }]);
    expect(changed).toHaveBeenCalled();
    expect(watch.satisfied(s)).toBe(true);
    watch.stop();
  });

  it("listens for exit intent only on a pointer device", () => {
    const add = vi.spyOn(document, "addEventListener");
    const s = survey({ triggers: [{ kind: "exit_intent", join: "and" }] });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const touch = createTriggerWatch(events, () => {}, since);
    touch.watch([s]);
    expect(add).not.toHaveBeenCalledWith("mouseout", expect.anything());

    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const changed = vi.fn();
    const mouse = createTriggerWatch(events, changed, since);
    mouse.watch([s]);
    document.dispatchEvent(new MouseEvent("mouseout", { clientY: 300 }));
    expect(mouse.satisfied(s)).toBe(false);
    document.dispatchEvent(new MouseEvent("mouseout", { clientY: -1 }));
    expect(changed).toHaveBeenCalled();
    expect(mouse.satisfied(s)).toBe(true);
    mouse.stop();
  });

  it("removes its listeners when no survey needs them, and on stop", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const remove = vi.spyOn(document, "removeEventListener");
    const s = survey({
      triggers: [
        { kind: "click", join: "and", selector: "#buy" },
        { kind: "exit_intent", join: "or" },
        { kind: "time_on_page", join: "or", seconds: 30 },
      ],
    });
    const watch = createTriggerWatch(events, () => {}, since);
    watch.watch([s]);
    expect(vi.getTimerCount()).toBe(1);
    watch.stop();
    expect(remove).toHaveBeenCalledWith("click", expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith("mouseout", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
