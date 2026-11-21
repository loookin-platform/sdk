// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mockFetch } from "./helpers";
import { loadSdk, setupPage } from "./page";

const options = { workspace: "acme", key: "pub_abc" };

setupPage();

/** Puts the page at a URL before the SDK loads, as a fresh page load would. */
const open = (url: string) => history.replaceState(null, "", url);

const setReferrer = (value: string) => vi.spyOn(document, "referrer", "get").mockReturnValue(value);

async function sent(loookin: Awaited<ReturnType<typeof loadSdk>>, calls: ReturnType<typeof mockFetch>) {
  await loookin.flush();
  return calls.flatMap((c) => c.events).map((e) => [e.event, e.properties]);
}

describe("auto-tracking off", () => {
  it.each([[undefined], [{}], [{ pageViews: false, campaigns: false }]])("sends nothing by itself with autoTrack %j", async (autoTrack) => {
    open("/pricing?utm_source=newsletter");
    const { pushState, replaceState } = history;
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack });
    loookin.identify("u1");
    history.pushState(null, "", "/features");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toHaveLength(0);
    expect(history.pushState).toBe(pushState); // the history methods are left alone
    expect(history.replaceState).toBe(replaceState);
  });

  it("leaves the history methods alone when only campaigns are on", async () => {
    const { pushState, replaceState } = history;
    mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { campaigns: true } });
    expect(history.pushState).toBe(pushState);
    expect(history.replaceState).toBe(replaceState);
  });
});

describe("page views", () => {
  it("sends page_viewed on init with the page and the referrer", async () => {
    open("/pricing?plan=pro#faq");
    setReferrer("https://search.example/");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { pageViews: true } });
    loookin.identify("u1");
    expect(await sent(loookin, calls)).toEqual([["page_viewed", { page: "/pricing", referrer: "https://search.example/" }]]);
  });

  it("leaves the referrer out when there is none", async () => {
    open("/pricing");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { pageViews: true } });
    loookin.identify("u1");
    expect(await sent(loookin, calls)).toEqual([["page_viewed", { page: "/pricing" }]]);
  });

  it("follows navigation in a single-page app, one event per navigation", async () => {
    open("/");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { pageViews: true } });
    loookin.identify("u1");

    history.pushState(null, "", "/reports");
    history.replaceState({ scroll: 0 }, "", "/reports"); // routers often do both
    history.replaceState(null, "", "/reports?tab=shared"); // same path: not a new page
    history.replaceState(null, "", "/reports/42"); // a redirect is one
    history.pushState(null, "", "/settings");

    expect((await sent(loookin, calls)).map(([, p]) => (p as { page: string }).page)).toEqual(["/", "/reports", "/reports/42", "/settings"]);
    expect(location.pathname).toBe("/settings"); // navigation itself still works
    expect(history.state).toBeNull();
  });

  it("sends page_viewed on back and forward", async () => {
    open("/a");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { pageViews: true } });
    loookin.identify("u1");
    history.pushState(null, "", "/b");

    // What the browser does on Back: the URL changes, then popstate fires.
    const { replaceState } = History.prototype;
    replaceState.call(history, null, "", "/a");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new PopStateEvent("popstate")); // a hash change fires it too

    expect((await sent(loookin, calls)).map(([, p]) => (p as { page: string }).page)).toEqual(["/a", "/b", "/a"]);
  });

  it("lets an error from the original history method through and sends nothing for it", async () => {
    open("/");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { pageViews: true } });
    loookin.identify("u1");
    expect(() => history.pushState(null, "", "https://other.example/x")).toThrow(); // cross-origin: SecurityError
    expect(await sent(loookin, calls)).toHaveLength(1);
  });

  it("holds automatic events until identify(), like any other event", async () => {
    open("/pricing?utm_campaign=spring");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { pageViews: true, campaigns: true } });
    history.pushState(null, "", "/signup");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);

    loookin.identify("u1");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.events.map((e) => [e.event, e.user])).toEqual([
      ["campaign_arrived", "u1"],
      ["page_viewed", "u1"],
      ["page_viewed", "u1"],
    ]);
  });
});

describe("campaigns", () => {
  it("sends campaign_arrived once per page load with the parameters that are present", async () => {
    open("/landing/spring?utm_source=newsletter&utm_campaign=spring_sale&utm_term=ignored&ref=x");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { campaigns: true } });
    loookin.identify("u1");
    history.pushState(null, "", "/pricing?utm_source=newsletter"); // still the same visit
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(await sent(loookin, calls)).toEqual([
      ["campaign_arrived", { utm_source: "newsletter", utm_campaign: "spring_sale", landing_page: "/landing/spring" }],
    ]);
  });

  it("sends all three parameters when all are there", async () => {
    open("/?utm_source=ads&utm_medium=cpc&utm_campaign=brand");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { campaigns: true } });
    loookin.identify("u1");
    expect(await sent(loookin, calls)).toEqual([
      ["campaign_arrived", { utm_source: "ads", utm_medium: "cpc", utm_campaign: "brand", landing_page: "/" }],
    ]);
  });

  it.each(["/pricing", "/pricing?ref=x&utm_term=shoes", "/pricing?utm_source="])("sends nothing for %s", async (url) => {
    open(url);
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, autoTrack: { campaigns: true } });
    loookin.identify("u1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);
  });
});
