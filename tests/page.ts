import { afterEach, beforeEach, vi } from "vitest";

let visibility: DocumentVisibilityState = "visible";
let listeners: [string, EventListenerOrEventListenerObject][] = [];

/** Loads a fresh copy of the SDK, as a new page load would. */
export async function loadSdk() {
  vi.resetModules();
  return (await import("../src/browser")).loookin;
}

export function hidePage() {
  visibility = "hidden";
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
    const add = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type: string, listener: any, opts?: any) => {
      listeners.push([type, listener]);
      add(type, listener, opts);
    });
  });

  afterEach(() => {
    for (const [type, listener] of listeners) document.removeEventListener(type, listener);
    listeners = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });
}
