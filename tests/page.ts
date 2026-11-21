import { afterEach, beforeEach, vi } from "vitest";

let visibility: DocumentVisibilityState = "visible";
let listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
const { pushState, replaceState } = history;

/** Loads a fresh copy of the SDK, as a new page load would. */
export async function loadSdk() {
  vi.resetModules();
  return (await import("../src/browser")).loookin;
}

export function hidePage() {
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
}

export function leavePage() {
  window.dispatchEvent(new Event("pagehide"));
}

/** The page comes back, for example from the back/forward cache. */
export function showPage() {
  visibility = "visible";
  window.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
}

export function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

/** Fake timers, a visible desktop page and a clean slate for every test. */
export function setupPage() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    setWidth(1280);
    // Remember listeners so that one test's SDK copy cannot act in the next.
    for (const target of [document, window]) {
      const add = target.addEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation((type: string, listener: any, opts?: any) => {
        listeners.push([target, type, listener]);
        add(type, listener, opts);
      });
    }
  });

  afterEach(() => {
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    listeners = [];
    history.pushState = pushState;
    history.replaceState = replaceState;
    pushState.call(history, null, "", "/");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });
}
