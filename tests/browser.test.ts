// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { accepted, failure, mockFetch } from "./helpers";
import { hidePage, leavePage, loadSdk, setupPage, setWidth, showPage } from "./page";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const options = { workspace: "acme", key: "pub_abc" };
const realCrypto = globalThis.crypto;

setupPage();

describe("tracking an identified user", () => {
  it("sends the event with user, company, properties and the time it happened", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1", { company: "c1" });
    loookin.track("report_exported", { format: "pdf" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://acme.loookin.com/api/events");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer pub_abc");
    expect(calls[0]!.events).toEqual([
      {
        eventId: expect.stringMatching(UUID),
        event: "report_exported",
        user: "u1",
        company: "c1",
        timestamp: "2026-03-01T10:00:00.000Z", // when track() ran, not when it was sent
        context: { platform: "web", device_type: "desktop" },
        properties: { format: "pdf" },
      },
    ]);
  });

  it("sends twenty quick events in one request", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    for (let i = 0; i < 20; i++) loookin.track("item_viewed", { position: i });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.events).toHaveLength(20);
    expect(new Set(calls[0]!.events.map((e) => e.eventId)).size).toBe(20);
  });

  it("sends the queue right away when the page is hidden", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    loookin.track("draft_saved");
    loookin.track("draft_saved");
    hidePage();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.events).toHaveLength(2);
    expect(calls[0]!.init.keepalive).toBe(true);
  });

  it("sends the queue on pagehide, in keepalive-sized batches, and only once", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    for (let i = 0; i < 25; i++) loookin.track("draft_saved", { note: "x".repeat(5_000) });
    leavePage(); // Safari: pagehide may come while the page still counts as visible
    hidePage();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flatMap((c) => c.events).length).toBe(25);
    expect(new Set(calls.flatMap((c) => c.events).map((e) => e.eventId)).size).toBe(25);
    for (const call of calls) {
      expect(call.body.length).toBeLessThanOrEqual(60_000);
      expect(call.init.keepalive).toBe(true);
    }

    showPage(); // back from the back/forward cache
    for (let i = 0; i < 25; i++) loookin.track("draft_saved", { note: "x".repeat(5_000) });
    const before = calls.length;
    await loookin.flush();
    expect(calls).toHaveLength(before + 1);
  });

  it.each(["network error", "503"])("sends the same events again after a %s", async (kind) => {
    const calls = mockFetch((_, n) => {
      if (n > 1) return accepted();
      if (kind === "503") return failure(503, "unavailable");
      throw new TypeError("Failed to fetch");
    });
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    loookin.track("order_placed");
    await loookin.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body); // same eventId: the server deduplicates
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
  });

  it("sends a throttled user's events after retryAfter without delaying others", async () => {
    const calls = mockFetch((_, n) =>
      n === 1 ? accepted({ accepted: 1, throttled: [{ user: "u1", count: 1, retryAfter: 30 }] }) : accepted(),
    );
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    loookin.track("first");
    loookin.identify("u2");
    loookin.track("second");
    await loookin.flush();
    expect(calls[0]!.events.map((e) => e.user)).toEqual(["u1", "u2"]);

    loookin.track("third");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.events.map((e) => e.event)).toEqual(["third"]);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.events).toEqual([calls[0]!.events[0]]);
  });

  it("does not carry the previous identity over after reset()", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1", { company: "c1" });
    loookin.track("before_logout");
    loookin.reset();
    loookin.track("after_logout");
    await loookin.flush();
    expect(calls[0]!.events.map((e) => e.event)).toEqual(["before_logout"]); // the other one waits

    loookin.identify("u2");
    await loookin.flush();
    expect(calls[1]!.events).toHaveLength(1);
    expect(calls[1]!.events[0]).toMatchObject({ event: "after_logout", user: "u2" });
    expect(calls[1]!.events[0]).not.toHaveProperty("company");
  });
});

describe("identity", () => {
  it("holds events tracked before identify() and sends them once it is called", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.track("page_opened");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);

    loookin.identify("u1", { company: "c1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.events[0]).toMatchObject({ event: "page_opened", user: "u1", company: "c1", timestamp: "2026-03-01T10:00:00.000Z" });
  });

  it("keeps calls made before init()", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.track("early_event");
    loookin.identify("u1");
    loookin.init({ ...options, appVersion: "2.4.0", session: "s_1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.events[0]).toMatchObject({
      event: "early_event",
      user: "u1",
      context: { platform: "web", device_type: "desktop", app_version: "2.4.0", session: "s_1" },
    });
  });

  it("ignores a second init()", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.init({ workspace: "other", key: "pub_other" });
    loookin.identify("u1");
    loookin.track("thing_done");
    await loookin.flush();
    expect(calls[0]!.url).toBe("https://acme.loookin.com/api/events");
  });

  it("uses a stored device id as the user in anonymous mode", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, anonymous: true });
    const device = localStorage.getItem("loookin_device");
    expect(device).toMatch(UUID);

    loookin.track("pricing_viewed");
    loookin.identify("u1");
    loookin.track("plan_chosen");
    await loookin.flush();
    // The anonymous event keeps the device id: history is not merged.
    expect(calls[0]!.events.map((e) => e.user)).toEqual([device, "u1"]);
  });

  it("reuses the device id on the next page load", async () => {
    mockFetch();
    localStorage.setItem("loookin_device", "11111111-1111-4111-8111-111111111111");
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, anonymous: true });
    loookin.track("pricing_viewed");
    await loookin.flush();
    expect(calls[0]!.events[0]!.user).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("creates a new device id on reset() in anonymous mode", async () => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, anonymous: true });
    const first = localStorage.getItem("loookin_device");
    loookin.identify("u1");
    loookin.reset();
    const second = localStorage.getItem("loookin_device");
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
    loookin.track("pricing_viewed");
    await loookin.flush();
    expect(calls[0]!.events[0]!.user).toBe(second);
  });

  it("falls back to an in-memory device id when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ ...options, anonymous: true });
    loookin.track("pricing_viewed");
    loookin.track("pricing_viewed");
    await loookin.flush();
    const users = calls[0]!.events.map((e) => e.user);
    expect(users[0]).toMatch(UUID);
    expect(users[1]).toBe(users[0]);
  });

  it("never touches localStorage, sessionStorage or cookies without anonymous mode", async () => {
    const storage = (["getItem", "setItem", "removeItem", "clear", "key"] as const).map((method) =>
      vi.spyOn(Storage.prototype, method),
    );
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const cookieRead = vi.spyOn(Document.prototype, "cookie", "get");
    const cookieWrite = vi.spyOn(Document.prototype, "cookie", "set");

    const calls = mockFetch((_, n) => (n === 1 ? failure(500, "boom") : accepted()));
    const loookin = await loadSdk();
    loookin.track("early_event");
    loookin.init({ ...options, debug: true, appVersion: "1.0.0" });
    loookin.identify("u1", { company: "c1" });
    loookin.track("thing_done", { ok: true });
    await loookin.flush();
    loookin.reset();
    loookin.track("after_reset");
    loookin.identify("u2");
    hidePage();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBeGreaterThan(1);

    for (const spy of [...storage, local, session, cookieRead, cookieWrite]) expect(spy).not.toHaveBeenCalled();
    expect(calls.every((c) => c.init.credentials === "omit")).toBe(true);
  });
});

describe("options", () => {
  it.each([
    ["acme", "https://acme.loookin.com/api/events"],
    ["https://acme.loookin.com", "https://acme.loookin.com/api/events"],
    ["https://acme.loookin.com/", "https://acme.loookin.com/api/events"],
    ["http://x.localhost:3000", "http://x.localhost:3000/api/events"],
  ])("resolves workspace %s", async (workspace, url) => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ workspace, key: "pub_abc" });
    loookin.identify("u1");
    loookin.track("thing_done");
    await loookin.flush();
    expect(calls[0]!.url).toBe(url);
  });

  it.each([
    [{ workspace: "", key: "pub_abc" }],
    [{ workspace: "acme" }],
    [{ workspace: "http://acme.example.com", key: "pub_abc" }], // plain http off localhost
    [undefined],
  ])("sends nothing with unusable options %j", async (bad) => {
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(bad as never);
    loookin.identify("u1");
    loookin.track("thing_done");
    await loookin.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [500, "mobile"],
    [800, "tablet"],
    [1024, "desktop"],
  ])("reports a %i px wide window as %s", async (width, deviceType) => {
    const calls = mockFetch();
    setWidth(width);
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    loookin.track("thing_done");
    await loookin.flush();
    expect(calls[0]!.events[0]!.context.device_type).toBe(deviceType);
  });

  it("refuses a server key: one console.error, nothing sent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", key: "ins_secret" });
    loookin.init({ workspace: "acme", key: "ins_secret" });
    loookin.identify("u1");
    for (let i = 0; i < 40; i++) loookin.track("thing_done");
    hidePage();
    await loookin.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain("ins_");
    expect(JSON.stringify(error.mock.calls)).not.toContain("ins_secret");
  });
});

describe("safety", () => {
  it("never throws into the page, whatever it is given", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch is broken");
      }),
    );
    const loookin = await loadSdk();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => {
      loookin.init(options);
      loookin.identify(undefined as never);
      loookin.identify("u1", null as never);
      loookin.track(undefined as never);
      loookin.track("thing_done", circular as never);
      loookin.track("thing_done", "nope" as never);
      loookin.track("thing_done", { fine: 1 });
      loookin.reset();
    }).not.toThrow();
    await expect(loookin.flush()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it("works on a page without crypto.randomUUID (plain http)", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => realCrypto.getRandomValues(bytes) });
    const calls = mockFetch();
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.identify("u1");
    loookin.track("thing_done");
    loookin.track("thing_done");
    await loookin.flush();
    const ids = calls[0]!.events.map((e) => e.eventId);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });
});
