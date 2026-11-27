// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SdkSurvey } from "../src/surveys/types";
import { mockFetch, mockSurveys, surveyCalls, surveyList } from "./helpers";
import { loadSdk, setupPage } from "./page";
import { $, $$, button, choice, message, rating, setupSurveys, shadow, survey, text, thanks } from "./surveys-helpers";

setupPage();
setupSurveys();

const events = () => surveyCalls.filter((c) => c.url.endsWith("/events")).map((c) => [c.body.event, c.body.stepKey]);

/** Opens the survey with showSurvey() and returns the SDK. */
async function open(definition: SdkSurvey, surveys: Record<string, unknown> = {}) {
  mockFetch();
  mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList([{ ...definition, triggers: [] }]) : undefined));
  const loookin = await loadSdk();
  loookin.init({ workspace: "acme", key: "pub_abc", surveys });
  loookin.identify("u1", { company: "c1" });
  await expect(loookin.showSurvey(definition.key)).resolves.toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  return loookin;
}

const click = (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  el!.click();
};
const next = () => $(".next") as HTMLButtonElement;
/** The step title without the required star. */
const title = () => $(".title")?.firstChild?.textContent;

describe("the host element", () => {
  it("draws into a shadow root on its own element and leaves the page's head, classes and styles alone", async () => {
    document.body.className = "app";
    document.documentElement.setAttribute("style", "color: red");
    const headBefore = document.head.innerHTML;
    await open(survey());
    const host = document.querySelector("loookin-survey");
    expect(host?.parentElement).toBe(document.body);
    expect(shadow()).not.toBeNull();
    expect(shadow()!.querySelector("style, link") ?? (shadow() as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets?.length).toBeTruthy();
    expect(document.head.innerHTML).toBe(headBefore);
    expect(document.body.className).toBe("app");
    expect(document.body.getAttribute("style")).toBeNull();
    expect(document.documentElement.getAttribute("style")).toBe("color: red"); // a Popup does not lock scrolling
  });

  it("inserts text from the definition as text, never as HTML", async () => {
    const evil = `<img src=x onerror="alert(1)">Hi`;
    await open(survey({ steps: [{ ...message("s_m"), title: evil, description: "<b>bold</b>", button: "<i>Go</i>" }] }));
    expect(title()).toBe(evil);
    expect($(".desc")?.textContent).toBe("<b>bold</b>");
    expect(next().textContent).toBe("<i>Go</i>");
    expect(shadow()!.querySelector("img, b, i")).toBeNull();
  });

  it("sets the Design as CSS variables and inherits the page's font by default", async () => {
    document.body.style.fontFamily = "Comic Neue, cursive";
    await open(survey({ design: { ...survey().design, accentColor: "#ff0066", borderRadius: 4 } }));
    const root = $(".root")!;
    expect(root.style.getPropertyValue("--cp-accent")).toBe("#ff0066");
    expect(root.style.getPropertyValue("--cp-radius")).toBe("4px");
    expect(root.style.getPropertyValue("--cp-font")).toContain("Comic Neue");
    document.body.removeAttribute("style");
  });

  it("never loads a web font by default: the page's font is used even when the Design names one", async () => {
    document.body.style.fontFamily = "Comic Neue, cursive";
    await open(survey({ design: { ...survey().design, font: "poppins" } }));
    expect(document.head.querySelector("link")).toBeNull();
    expect($(".root")!.style.getPropertyValue("--cp-font")).toContain("Comic Neue");
    document.body.removeAttribute("style");
  });

  it("with webFonts: true loads the font the Design asks for, as the hosted page does, and removes it on close", async () => {
    await open(survey({ design: { ...survey().design, font: "poppins" } }), { webFonts: true });
    const link = document.head.querySelector<HTMLLinkElement>("link[data-loookin-font]");
    expect(link?.href).toBe("https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap");
    expect($(".root")!.style.getPropertyValue("--cp-font")).toBe("Poppins, sans-serif");
    click(button("Close"));
    expect(document.head.querySelector("link[data-loookin-font]")).toBeNull();
  });

  it("shows a Test label for a test run", async () => {
    await open(survey({ isTest: true }));
    expect($(".test")?.textContent).toBe("Test");
  });
});

describe("steps", () => {
  it("rating: Next waits for a score on a required step, the score is pressed, the progress bar fills", async () => {
    await open(survey({ steps: [rating("s_nps"), text("s_why"), thanks()] }));
    expect(title()).toBe("How likely are you to recommend us?");
    expect($(".req")).not.toBeNull();
    expect($$(".scale button")).toHaveLength(11);
    expect(next().disabled).toBe(true);
    const segments = $$(".progress span");
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.className)).toEqual(["on", ""]);

    click(button("9"));
    expect(button("9")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("8")!.getAttribute("aria-pressed")).toBe("false");
    expect(next().disabled).toBe(false);
    click(next());
    expect(title()).toBe("Tell us more");
    expect($$(".progress span").map((s) => s.className)).toEqual(["on", "on"]);
  });

  it("stars fill up to the chosen value", async () => {
    await open(survey({ steps: [rating("s_stars", "stars"), thanks()] }));
    click(button("3"));
    expect($$(".icons button").map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "true", "true", "false", "false"]);
  });

  it("choice: single picks one, multiple toggles", async () => {
    await open(
      survey({
        steps: [choice("s_plan", ["o_free", "o_pro"]), choice("s_use", ["o_a", "o_b"], { multiple: true, required: true } as never), thanks()],
      }),
    );
    click(button("O_FREE"));
    click(button("O_PRO"));
    expect($$(".options button").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    click(next());
    expect(next().disabled).toBe(true);
    click(button("O_A"));
    click(button("O_B"));
    click(button("O_A"));
    expect($$(".options button").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(next().disabled).toBe(false);
  });

  it("text: typing enables a required step and Enter goes on", async () => {
    await open(survey({ steps: [text("s_role", "Your role?", { required: true } as never), message("s_after", "After")] }));
    const field = $("input") as HTMLInputElement;
    expect(field.getAttribute("aria-required")).toBe("true");
    expect(next().disabled).toBe(true);
    field.value = "   ";
    field.dispatchEvent(new Event("input"));
    expect(next().disabled).toBe(true); // spaces are not an answer
    field.value = "Engineer";
    field.dispatchEvent(new Event("input"));
    expect(next().disabled).toBe(false);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(title()).toBe("After");
  });

  it("Back returns to the previous step with its answer", async () => {
    await open(survey({ steps: [rating("s_nps", "ten"), text("s_why"), thanks()] }));
    expect(button("Back")).toBeNull();
    click(button("7"));
    click(next());
    click(button("Back"));
    expect(title()).toBe("How likely are you to recommend us?");
    expect(button("7")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("sends the response and shows the thank you, which closes by itself", async () => {
    await open(survey({ steps: [rating("s_nps"), thanks("s_end", "Thanks a lot")] }));
    click(button("10"));
    click(next());
    await vi.advanceTimersByTimeAsync(0);
    expect(title()).toBe("Thanks a lot");
    expect($(".done-icon")).not.toBeNull();
    expect($(".next")).toBeNull();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(shadow()).toBeNull();
    expect(events().map(([e]) => e)).not.toContain("survey_dismissed");
  });

  it("keeps the answers and offers to try again when sending fails", async () => {
    await open(survey({ steps: [rating("s_nps"), thanks()] }));
    mockSurveys((call) => (call.url.endsWith("/responses") ? new Response("{}", { status: 503 }) : undefined));
    click(button("6"));
    click(next());
    await vi.advanceTimersByTimeAsync(0);
    expect($(".notice")?.textContent).toBe("We couldn't save your answer. Try again.");
    expect(next().disabled).toBe(false);
    mockSurveys(() => undefined);
    click(next());
    await vi.advanceTimersByTimeAsync(0);
    const responses = surveyCalls.filter((c) => c.url.endsWith("/responses"));
    expect(responses).toHaveLength(2);
    expect(responses[1]!.body.submissionId).toBe(responses[0]!.body.submissionId);
    expect(title()).toBe("Thank you");
  });
});

describe("closing", () => {
  it("the close button removes the survey and reports survey_dismissed", async () => {
    await open(survey());
    click(button("Close"));
    await vi.advanceTimersByTimeAsync(0);
    expect(shadow()).toBeNull();
    expect(events().slice(-1)[0]).toEqual(["survey_dismissed", undefined]);
  });

  it("Escape closes a Popup that has a close button, and not one without", async () => {
    await open(survey());
    $(".card")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shadow()).toBeNull();

    await open(survey({ design: { ...survey().design, closeButton: false } }));
    expect(button("Close")).toBeNull();
    $(".card")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shadow()).not.toBeNull();
  });

  it("Escape always closes a Modal, also one without a close button, and restores scrolling", async () => {
    document.documentElement.removeAttribute("style");
    await open(survey({ format: "modal", design: { ...survey().design, closeButton: false } }));
    expect(button("Close")).toBeNull();
    $(".card")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shadow()).toBeNull();
    expect(document.documentElement.getAttribute("style")).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(events().slice(-1)[0]).toEqual(["survey_dismissed", undefined]);
  });
});

describe("Modal", () => {
  it.each([[null], ["color: red"], ["overflow: scroll; color: red"]])("locks scrolling and restores the html style %j exactly", async (style) => {
    if (style === null) document.documentElement.removeAttribute("style");
    else document.documentElement.setAttribute("style", style);
    await open(survey({ format: "modal" }));
    expect(document.documentElement.style.getPropertyValue("overflow")).toBe("hidden");
    click(button("Close"));
    expect(document.documentElement.getAttribute("style")).toBe(style);
  });

  it("moves the focus in, keeps Tab inside and gives the focus back on close", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await open(survey({ format: "modal" }));
    expect(shadow()!.activeElement).not.toBeNull();
    const card = $(".card")!;
    const focusable = $$("button:not(:disabled)");
    focusable[focusable.length - 1]!.focus();
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(shadow()!.activeElement).toBe(focusable[0]);
    click(button("Close"));
    expect(document.activeElement).toBe(outside);
  });

  it("draws the backdrop unless the Design turns it off", async () => {
    await open(survey({ format: "modal" }));
    expect($(".overlay")?.classList.contains("backdrop")).toBe(true);
    click(button("Close"));
    await open(survey({ format: "modal", design: { ...survey().design, backdrop: false } }));
    expect($(".overlay")?.classList.contains("backdrop")).toBe(false);
  });
});

describe("Popup", () => {
  it("sits in the Design's corner and does not take the focus", async () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    await open(survey({ design: { ...survey().design, position: "top-left" } }));
    expect($(".card")!.className).toContain("top-left");
    expect(document.activeElement).toBe(outside);
  });
});
