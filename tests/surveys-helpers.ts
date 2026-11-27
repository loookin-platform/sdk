import { beforeEach, vi } from "vitest";
import type { SdkSurvey, Step } from "../src/surveys/types";

const stepBase = { description: "", button: "Next", required: false };

export const message = (key: string, title = "Hello"): Step => ({ ...stepBase, key, title, type: "message" });
export const thanks = (key = "s_thanks", title = "Thank you"): Step => ({ ...stepBase, key, title, type: "thanks", button: "" });
export const text = (key: string, title = "Tell us more", extra: Partial<Step> = {}): Step =>
  ({ ...stepBase, key, title, type: "text", long: false, placeholder: "", ...extra }) as Step;
export const rating = (key: string, scale: "nps" | "ten" | "stars" | "emoji" = "nps", extra: Partial<Step> = {}): Step =>
  ({ ...stepBase, key, title: "How likely are you to recommend us?", type: "rating", scale, lowLabel: "Not likely", highLabel: "Very likely", required: true, ...extra }) as Step;
export const choice = (key: string, options: string[], extra: Partial<Step> = {}): Step =>
  ({ ...stepBase, key, title: "Which plan?", type: "choice", multiple: false, options: options.map((o) => ({ key: o, label: o.toUpperCase() })), ...extra }) as Step;

/** A Popup with a page_load (any page) trigger and a two-step flow, as the server sends it. */
export function survey(overrides: Partial<SdkSurvey> = {}): SdkSurvey {
  return {
    key: "nps",
    versionId: "v1",
    format: "popup",
    schema: 1,
    priority: "medium",
    isTest: false,
    design: {
      accentColor: "#006eff",
      pageBg: "#f7f7f8",
      cardBg: "#ffffff",
      textColor: "#1a1a1e",
      borderRadius: 12,
      font: "inherit",
      edge: "shadow",
      progress: true,
      closeButton: true,
      position: "bottom-right",
    },
    steps: [rating("s_nps"), thanks()],
    triggers: [{ kind: "page_load", join: "and", pages: "any", hideOutside: true }],
    showAgain: true,
    language: "en",
    ...overrides,
  };
}

/** Lets the list request, the dynamic import of the surveys entry and what follows finish. */
export async function settle() {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await vi.dynamicImportSettled();
  }
  await vi.advanceTimersByTimeAsync(0);
}

/** The survey's shadow root, or null when nothing is on the page. */
export const shadow = (): ShadowRoot | null => document.querySelector("loookin-survey")?.shadowRoot ?? null;

export const $ = (selector: string) => shadow()?.querySelector<HTMLElement>(selector) ?? null;
export const $$ = (selector: string) => Array.from(shadow()?.querySelectorAll<HTMLElement>(selector) ?? []);

/** The button with this exact text inside the survey. */
export const button = (label: string) => $$("button").find((b) => b.textContent === label || b.getAttribute("aria-label") === label) ?? null;

/** An in-memory BroadcastChannel: every instance with the same name hears the others. */
export class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    for (const other of FakeChannel.all) {
      if (other !== this && !other.closed && other.name === this.name) other.onmessage?.({ data } as MessageEvent);
    }
  }
  close() {
    this.closed = true;
  }
}

/** Fake BroadcastChannel and a clean body for every test. */
export function setupSurveys() {
  beforeEach(() => {
    FakeChannel.all = [];
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    document.body.replaceChildren();
    document.head.replaceChildren();
  });
}
