// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SdkSurvey } from "../src/surveys/types";
import { mockFetch, mockSurveys, surveyCalls, surveyList } from "./helpers";
import { hidePage, loadSdk, setupPage, showPage } from "./page";
import { $, button, FakeChannel, rating, settle, setupSurveys, shadow, survey, text, thanks } from "./surveys-helpers";

setupPage();
setupSurveys();

const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SDK_EVENTS = ["survey_viewed", "survey_started", "survey_step_reached", "survey_step_answered", "survey_dismissed"];
const eventCalls = () => surveyCalls.filter((c) => c.url.endsWith("/events"));
const events = () => eventCalls().map((c) => [c.url.split("/").slice(-2)[0], c.body.event, c.body.stepKey]);
const shownKey = () => (shadow() ? document.querySelector("loookin-survey") && $(".title")?.firstChild?.textContent : null);

async function start(list: SdkSurvey[], init: Record<string, unknown> = {}) {
  mockFetch();
  mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList(list) : undefined));
  const loookin = await loadSdk();
  loookin.init({ workspace: "acme", key: "pub_abc", ...init });
  loookin.identify("u1", { company: "c1" });
  await settle();
  return loookin;
}

const titled = (key: string, extra: Partial<SdkSurvey> = {}) => survey({ key, steps: [{ ...text(`s_${key}`), title: key }, thanks()], ...extra });

describe("which survey shows", () => {
  it("shows the first survey whose triggers hold, one at a time, the next after an address change", async () => {
    await start([titled("high"), titled("low")]);
    expect(document.querySelectorAll("loookin-survey")).toHaveLength(1);
    expect(shownKey()).toBe("high");

    button("Close")!.click();
    await settle();
    expect(shadow()).toBeNull(); // the next waits for the next address change

    history.pushState(null, "", "/next-page");
    await settle();
    expect(shownKey()).toBe("low");
  });

  it("does not show a survey again on the same page load", async () => {
    await start([titled("only")]);
    button("Close")!.click();
    history.pushState(null, "", "/a");
    await settle();
    expect(shadow()).toBeNull();
  });

  it("ignores unknown formats and definitions with a higher schema, silently", async () => {
    const errors = vi.spyOn(console, "error");
    await start([titled("page", { format: "page" }), titled("carousel", { format: "carousel" }), titled("future", { schema: 2 }), titled("popup")]);
    expect(shownKey()).toBe("popup");
    expect(errors).not.toHaveBeenCalled();
  });

  it("never shows a survey without triggers on its own", async () => {
    const loookin = await start([titled("manual", { triggers: [] })]);
    expect(shadow()).toBeNull();
    await expect(loookin.showSurvey("manual")).resolves.toBe(true);
    await expect(loookin.showSurvey("manual")).resolves.toBe(false); // one is open already
  });

  it("shows on an event from track()", async () => {
    const loookin = await start([titled("after_order", { triggers: [{ kind: "event", join: "and", event: "order_completed" }] })]);
    expect(shadow()).toBeNull();
    loookin.track("something_else");
    await settle();
    expect(shadow()).toBeNull();
    loookin.track("order_completed");
    await settle();
    expect(shownKey()).toBe("after_order");
  });

  it("needs both sides of an and: event and time on page", async () => {
    const loookin = await start([
      titled("both", {
        triggers: [
          { kind: "event", join: "and", event: "order_completed" },
          { kind: "time_on_page", join: "and", seconds: 5 },
        ],
      }),
    ]);
    loookin.track("order_completed");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(shadow()).toBeNull();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(shownKey()).toBe("both");
  });

  it("does not show in a hidden tab, and shows when it comes back", async () => {
    mockFetch();
    mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList([titled("later")]) : undefined));
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", key: "pub_abc" });
    hidePage();
    loookin.identify("u1");
    await settle();
    expect(shadow()).toBeNull();
    showPage();
    await settle();
    expect(shownKey()).toBe("later");
  });

  it("hides the survey when the address leaves its pages, without reporting a dismissal", async () => {
    history.replaceState(null, "", "/orders");
    await start([titled("orders", { triggers: [{ kind: "page_load", join: "and", pages: [{ op: "starts_with", value: "/orders" }], hideOutside: true }] })]);
    expect(shownKey()).toBe("orders");
    history.pushState(null, "", "/orders/2");
    await settle();
    expect(shownKey()).toBe("orders");
    history.pushState(null, "", "/settings");
    await settle();
    expect(shadow()).toBeNull();
    expect(events().map(([, e]) => e)).not.toContain("survey_dismissed");
  });
});

describe("two tabs", () => {
  it("tells the other tabs which survey it shows", async () => {
    const other = new FakeChannel("loookin-surveys");
    const heard: unknown[] = [];
    other.onmessage = (e) => heard.push(e.data);
    await start([titled("nps")]);
    expect(heard).toEqual([{ open: "nps" }]);
  });

  it("does not show a survey another tab is showing", async () => {
    mockFetch();
    mockSurveys((call) => (call.url.endsWith("/surveys") ? surveyList([titled("nps", { triggers: [{ kind: "time_on_page", join: "and", seconds: 2 }] })]) : undefined));
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", key: "pub_abc" });
    loookin.identify("u1");
    await settle();
    new FakeChannel("loookin-surveys").postMessage({ open: "nps" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(shadow()).toBeNull();
  });
});

describe("identity", () => {
  it("reset() closes the open survey without reporting a dismissal and drops the list", async () => {
    const loookin = await start([titled("nps")]);
    expect(shadow()).not.toBeNull();
    loookin.reset();
    expect(shadow()).toBeNull();
    expect(events().map(([, e]) => e)).not.toContain("survey_dismissed");
    history.pushState(null, "", "/again");
    await settle();
    expect(shadow()).toBeNull();
  });

  it("a new identity closes the survey and asks again", async () => {
    const loookin = await start([titled("nps")]);
    loookin.identify("u2");
    expect(shadow()).toBeNull();
    await settle();
    expect(surveyCalls.filter((c) => c.url.endsWith("/surveys")).map((c) => c.body.identity)).toEqual([{ user: "u1", company: "c1" }, { user: "u2" }]);
  });

  it("stop() closes the survey and removes its listeners", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const remove = vi.spyOn(document, "removeEventListener");
    const loookin = await start([
      titled("a"),
      titled("b", {
        triggers: [
          { kind: "click", join: "and", selector: "#buy" },
          { kind: "exit_intent", join: "or" },
        ],
      }),
    ]);
    button("Close")!.click();
    loookin.stop();
    expect(shadow()).toBeNull();
    const types = remove.mock.calls.map(([type]) => type);
    expect(types).toEqual(expect.arrayContaining(["click", "mouseout", "visibilitychange"]));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("what is sent", () => {
  it("events and the response have the shapes the server routes parse", async () => {
    await start([survey({ key: "nps", versionId: "ver_1", steps: [rating("s_nps"), text("s_why"), thanks()] })]);
    button("9")!.click();
    $(".next")!.click();
    $(".next")!.click(); // the optional text left empty
    await settle();

    expect(events()).toEqual([
      ["nps", "survey_viewed", undefined],
      ["nps", "survey_step_reached", "s_nps"],
      ["nps", "survey_started", undefined],
      ["nps", "survey_step_answered", "s_nps"],
      ["nps", "survey_step_reached", "s_why"],
    ]);
    const bodies = eventCalls().map((c) => c.body);
    const session = bodies[0]!.session;
    expect(session).toMatch(PUBLIC_ID);
    for (const body of bodies) {
      expect(body).toMatchObject({ identity: { user: "u1", company: "c1" }, versionId: "ver_1", session });
      expect(SDK_EVENTS).toContain(body.event);
      expect(Object.keys(body).sort()).toEqual(body.stepKey ? ["event", "identity", "session", "stepKey", "versionId"] : ["event", "identity", "session", "versionId"]);
    }

    const response = surveyCalls.find((c) => c.url === "https://acme.loookin.com/api/sdk/surveys/nps/responses")!;
    expect(response.body).toEqual({
      identity: { user: "u1", company: "c1" },
      versionId: "ver_1",
      session,
      submissionId: expect.stringMatching(PUBLIC_ID),
      answers: [{ stepKey: "s_nps", score: 9 }],
    });
    expect(response.body.submissionId).not.toBe(session);
    // No keepalive for the response: its 64 KiB cap would refuse a long answer.
    expect(response.init).toMatchObject({ credentials: "omit", keepalive: false });
    expect(eventCalls().every((c) => c.init.keepalive === true)).toBe(true);
  });

  it("a test run shows its label and sends the same requests; the server records nothing for it", async () => {
    await start([survey({ key: "draft", isTest: true })]);
    expect($(".test")?.textContent).toBe("Test");
    expect(events()[0]).toEqual(["draft", "survey_viewed", undefined]);
  });

  it("reports survey_viewed only when the survey is actually shown", async () => {
    await start([titled("later", { triggers: [{ kind: "time_on_page", join: "and", seconds: 30 }] })]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(eventCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(events()[0]).toEqual(["later", "survey_viewed", undefined]);
  });
});
