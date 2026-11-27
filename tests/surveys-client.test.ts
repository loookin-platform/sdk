// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { failure, json, mockFetch, mockSurveys, silentServer, surveyCalls, surveyList } from "./helpers";
import { hidePage, loadSdk, setupPage, showPage } from "./page";
import { settle, setupSurveys, shadow, survey } from "./surveys-helpers";

const options = { workspace: "acme", key: "pub_abc" };
const LIST = "https://acme.loookin.com/api/sdk/surveys";
const lists = () => surveyCalls.filter((c) => c.url === LIST);

setupPage();
setupSurveys();
afterEach(() => vi.doUnmock("../src/surveys"));

/** Replaces the surveys entry with a spy, to see whether the core loads it. */
function spyOnSurveysEntry() {
  const loaded = vi.fn();
  const unmount = vi.fn();
  const controller = { update: vi.fn(), track: vi.fn(), address: vi.fn(), check: vi.fn(), show: vi.fn(async () => true), mount: vi.fn(() => unmount), close: vi.fn(), stop: vi.fn() };
  vi.doMock("../src/surveys", () => ({
    startSurveys: (host: unknown) => {
      loaded(host);
      return controller;
    },
  }));
  return { loaded, controller, unmount };
}

describe("asking for surveys", () => {
  it("asks once after identify, with the identity and the schema, and nothing else", async () => {
    mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(surveyCalls).toHaveLength(0); // no identity, no question

    loookin.identify("u1", { company: "c1" });
    loookin.identify("u1", { company: "c1" }); // the same identity again
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lists()).toHaveLength(1);
    const [call] = lists();
    expect(call!.body).toEqual({ identity: { user: "u1", company: "c1" }, schema: 1 });
    // No keepalive: its 64 KiB budget is for events, and a list answer is not needed after the page is gone.
    expect(call!.init).toMatchObject({ method: "POST", credentials: "omit", keepalive: false, redirect: "error" });
    expect((call!.init.headers as Record<string, string>).Authorization).toBe("Bearer pub_abc");
  });

  it("asks with anonymous: true in anonymous mode, and sends the language when given", async () => {
    mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, anonymous: true, surveys: { language: "de" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(lists().map((c) => c.body)).toEqual([{ identity: { anonymous: true }, schema: 1, language: "de" }]);
  });

  it("asks again after an identity change and after reset in anonymous mode", async () => {
    mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, anonymous: true });
    loookin.identify("u1");
    loookin.identify("u2", { company: "c2" });
    loookin.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(lists().map((c) => c.body.identity)).toEqual([{ anonymous: true }, { user: "u1" }, { user: "u2", company: "c2" }, { anonymous: true }]);
  });

  it("never asks with surveys: false", async () => {
    mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, surveys: false });
    loookin.identify("u1");
    await expect(loookin.showSurvey("nps")).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(surveyCalls).toHaveLength(0);
  });
});

describe("failures", () => {
  it("gives up after 5 seconds, shows nothing and throws nothing", async () => {
    const timeouts = silentServer();
    const errors = vi.spyOn(console, "error");
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    const shown = loookin.showSurvey("nps");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(shown).resolves.toBe(false);
    expect(timeouts).toEqual([5_000]); // one request, no retry
    expect(shadow()).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ["network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["500", () => failure(500, "boom")],
    ["403", () => failure(403, "origin_not_allowed")],
    ["not JSON", () => new Response("<html>login</html>", { status: 200 })],
    ["wrong shape", () => json(200, { data: { surveys: "nope" } })],
  ])("treats a %s as no surveys, without loading the renderer", async (_, answer) => {
    const { loaded } = spyOnSurveysEntry();
    mockFetch();
    mockSurveys(answer as never);
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toHaveLength(1);
    expect(loaded).not.toHaveBeenCalled();
    await expect(loookin.showSurvey("nps")).resolves.toBe(false);
    expect(lists()).toHaveLength(1); // a failure counts as a list until its ttl
  });
});

describe("loading the renderer", () => {
  it("does not load it for an empty list", async () => {
    const { loaded } = spyOnSurveysEntry();
    mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toHaveLength(1);
    expect(loaded).not.toHaveBeenCalled();
  });

  it("does not load it for a mountSurvey alone, with no list or an empty one", async () => {
    const { loaded } = spyOnSurveysEntry();
    mockFetch();
    const loookin = await loadSdk();
    const remove = loookin.mountSurvey("inline", document.body);
    await settle();
    expect(loaded).not.toHaveBeenCalled();
    loookin.init(options);
    loookin.identify("u1");
    await settle();
    expect(lists()).toHaveLength(1);
    expect(loaded).not.toHaveBeenCalled();
    expect(() => remove()).not.toThrow();
  });

  it("hands mounts made before the renderer loaded over to it, and their remove functions too", async () => {
    const { loaded, controller, unmount } = spyOnSurveysEntry();
    mockFetch();
    mockSurveys(() => surveyList([survey({ key: "inline", format: "embed", triggers: [] })]));
    const loookin = await loadSdk();
    const slot = document.createElement("div");
    const remove = loookin.mountSurvey("inline", slot);
    loookin.init(options);
    loookin.identify("u1");
    await settle();
    expect(loaded).toHaveBeenCalledTimes(1);
    // The renderer takes over the mounts recorded before it loaded.
    const host = loaded.mock.calls[0]![0] as { mounts: Set<[string, unknown, (() => void)?]> };
    expect([...host.mounts].map(([key, target]) => [key, target])).toEqual([["inline", slot]]);
    [...host.mounts][0]![2] = unmount;
    loookin.mountSurvey("later", "#slot");
    expect(controller.mount).toHaveBeenLastCalledWith("later", "#slot");
    remove();
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it("loads it for any non-empty list; the renderer itself skips formats and schemas it cannot draw", async () => {
    const { loaded, controller } = spyOnSurveysEntry();
    mockFetch();
    const list = [survey({ key: "c", format: "carousel" }), survey({ key: "p" })];
    mockSurveys(() => surveyList(list));
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await settle();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(controller.update).toHaveBeenCalledWith(list);

    loookin.track("order_completed");
    expect(controller.track).toHaveBeenCalledWith("order_completed");
    const host = loaded.mock.calls[0]![0] as { events: Set<string> };
    expect(host.events.has("order_completed")).toBe(true);
  });

  it("does not apply a list that was replaced while the renderer was loading", async () => {
    let finishImport!: () => void;
    const importing = new Promise<void>((resolve) => (finishImport = resolve));
    const controller = { update: vi.fn(), track: vi.fn(), address: vi.fn(), check: vi.fn(), show: vi.fn(), close: vi.fn(), stop: vi.fn() };
    vi.doMock("../src/surveys", async () => {
      await importing; // a slow network
      return { startSurveys: () => controller };
    });
    mockFetch();
    mockSurveys((call) => surveyList(call.body.identity.user === "u1" ? [survey({ key: "for_u1" })] : []));
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await vi.advanceTimersByTimeAsync(0); // the answer for u1 is in, the import is still loading
    loookin.identify("u2");
    await vi.advanceTimersByTimeAsync(0); // the empty answer for u2 is in
    finishImport();
    await settle();
    expect(lists()).toHaveLength(2);
    expect(controller.update).not.toHaveBeenCalled();
  });
});

describe("ttl", () => {
  async function started(ttl = 300) {
    mockFetch();
    mockSurveys(() => surveyList([], ttl));
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toHaveLength(1);
    return loookin;
  }

  it("has no background timer: time alone never asks again", async () => {
    await started();
    await vi.advanceTimersByTimeAsync(3 * 3600_000);
    expect(lists()).toHaveLength(1);
  });

  it("asks again on a navigation only after the ttl", async () => {
    mockFetch();
    mockSurveys(() => surveyList([survey({ key: "manual", triggers: [] })], 300));
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await settle();
    history.pushState(null, "", "/a");
    await settle();
    expect(lists()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300_000);
    history.replaceState(null, "", "/a?q=typing"); // a search box: not a navigation
    await settle();
    expect(lists()).toHaveLength(1);
    history.pushState(null, "", "/b");
    await settle();
    expect(lists()).toHaveLength(2);
    loookin.stop();
  });

  it("asks again when the tab becomes visible after the ttl", async () => {
    await started(60);
    hidePage();
    showPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    hidePage();
    expect(lists()).toHaveLength(1);
    showPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toHaveLength(2);
  });

  it("asks again before showing from a stale list, and shows nothing the fresh list dropped", async () => {
    mockFetch();
    mockSurveys((_, n) => surveyList(n === 1 ? [survey({ key: "nps", triggers: [] })] : []));
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(301_000);

    await expect(loookin.showSurvey("nps")).resolves.toBe(false);
    expect(lists()).toHaveLength(2);
    expect(shadow()).toBeNull();
  });

  it("shows from a fresh list without asking again", async () => {
    mockFetch();
    mockSurveys(() => surveyList([survey({ key: "nps", triggers: [] })]));
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await vi.advanceTimersByTimeAsync(0);
    await expect(loookin.showSurvey("nps")).resolves.toBe(true);
    expect(lists()).toHaveLength(1);
    expect(shadow()).not.toBeNull();
    await expect(loookin.showSurvey("missing")).resolves.toBe(false);
  });
});

describe("stop()", () => {
  it("removes the page listeners and asks nothing more", async () => {
    mockFetch();
    mockSurveys(() => surveyList([survey({ key: "manual", triggers: [] })], 1));
    const remove = [vi.spyOn(window, "removeEventListener"), vi.spyOn(document, "removeEventListener")];
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    loookin.stop();
    const removed = remove.flatMap((spy) => spy.mock.calls.map(([type]) => type));
    expect(removed).toEqual(expect.arrayContaining(["popstate", "hashchange", "visibilitychange", "pagehide", "pageshow"]));

    history.pushState(null, "", "/after-stop");
    showPage();
    await settle();
    await expect(loookin.showSurvey("manual")).resolves.toBe(false);
    expect(lists()).toHaveLength(1);
  });
});
