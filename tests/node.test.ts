// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/node";
import { accepted, failure, mockFetch } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const options = { workspace: "acme", key: "ins_secret" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("track", () => {
  it("sends the event for the given company with server context", async () => {
    const calls = mockFetch();
    const client = createClient(options);
    expect(client.track({ event: "order_placed", company: "c1", properties: { total: 12 }, context: { source: "api" } })).toEqual({ ok: true });
    expect(client.track({ event: "import_finished", user: "u1", timestamp: new Date("2026-02-01T00:00:00Z") })).toEqual({ ok: true });
    await client.flush();

    expect(calls[0]!.url).toBe("https://acme.loookin.com/api/events");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer ins_secret");
    expect(calls[0]!.events).toEqual([
      {
        eventId: expect.stringMatching(UUID),
        event: "order_placed",
        company: "c1",
        timestamp: "2026-03-01T10:00:00.000Z",
        context: { source: "api", platform: "server" },
        properties: { total: 12 },
      },
      {
        eventId: expect.stringMatching(UUID),
        event: "import_finished",
        user: "u1",
        timestamp: "2026-02-01T00:00:00.000Z",
        context: { platform: "server" },
      },
    ]);
  });

  it("returns an error right away when the event cannot be sent as given", async () => {
    const calls = mockFetch();
    const client = createClient(options);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(client.track({ event: "order_placed" })).toEqual({ ok: false, error: expect.stringContaining("identity is missing") });
    expect(client.track({ event: "order_placed", company: "  " })).toMatchObject({ ok: false });
    expect(client.track({ company: "c1" } as never)).toEqual({ ok: false, error: expect.stringContaining("event name") });
    expect(client.track({ event: "order_placed", company: "c1", properties: circular as never })).toEqual({
      ok: false,
      error: expect.stringContaining("serialized"),
    });
    expect(client.track({ event: "order_placed", company: "c1", properties: [1] as never })).toMatchObject({ ok: false });
    expect(client.track({ event: "order_placed", company: "c1", timestamp: "yesterday" })).toMatchObject({ ok: false });
    expect(client.track(undefined as never)).toMatchObject({ ok: false });

    await client.flush();
    expect(calls).toHaveLength(0);
  });

  it("returns an error from a client without workspace or key, without throwing", () => {
    expect(createClient({ workspace: "acme" } as never).track({ event: "order_placed", company: "c1" })).toMatchObject({ ok: false });
    expect(createClient(undefined as never).track({ event: "order_placed", company: "c1" })).toMatchObject({ ok: false });
  });

  it("appends ?dryRun=true in dry run", async () => {
    const calls = mockFetch();
    const client = createClient({ ...options, dryRun: true });
    client.track({ event: "order_placed", company: "c1" });
    await client.flush();
    expect(calls[0]!.url).toBe("https://acme.loookin.com/api/events?dryRun=true");
  });
});

describe("sending", () => {
  it("waits for Retry-After and sends the identical batch", async () => {
    const calls = mockFetch((_, n) => (n === 1 ? failure(429, "rate_limited", { "Retry-After": "20" }) : accepted()));
    const client = createClient(options);
    client.track({ event: "order_placed", company: "c1" });
    await client.flush();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it("stops after a 401 and says so from track()", async () => {
    const calls = mockFetch(() => failure(401, "Unauthorized"));
    const client = createClient(options);
    client.track({ event: "order_placed", company: "c1" });
    await client.flush();
    expect(client.track({ event: "order_placed", company: "c1" })).toEqual({ ok: false, error: expect.stringContaining("sending is off") });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toHaveLength(1);
  });

  it("keeps two clients independent", async () => {
    const calls = mockFetch((call) => (call.url.includes("first") ? failure(401, "Unauthorized") : accepted()));
    const first = createClient({ workspace: "first", key: "ins_one" });
    const second = createClient({ workspace: "second", key: "ins_two" });
    first.track({ event: "order_placed", company: "c1" });
    second.track({ event: "order_placed", company: "c2" });
    await Promise.all([first.flush(), second.flush()]);

    expect(calls.map((c) => [c.url, (c.init.headers as Record<string, string>).Authorization, c.events[0]!.company]).sort()).toEqual([
      ["https://first.loookin.com/api/events", "Bearer ins_one", "c1"],
      ["https://second.loookin.com/api/events", "Bearer ins_two", "c2"],
    ]);
    expect(first.track({ event: "order_placed", company: "c1" })).toMatchObject({ ok: false });
    expect(second.track({ event: "order_placed", company: "c2" })).toEqual({ ok: true });
    await first.shutdown();
    expect(second.track({ event: "order_placed", company: "c2" })).toEqual({ ok: true });
    await second.flush();
    expect(calls).toHaveLength(3);
  });
});

describe("shutdown", () => {
  it("sends everything that is queued before it resolves", async () => {
    const calls = mockFetch();
    const client = createClient(options);
    for (let i = 0; i < 510; i++) client.track({ event: "row_imported", company: "c1", properties: { row: i } });
    await vi.advanceTimersByTimeAsync(0); // the first batch is already on its way
    await client.shutdown();
    expect(calls.reduce((sum, c) => sum + c.events.length, 0)).toBe(510);

    expect(client.track({ event: "row_imported", company: "c1" })).toEqual({ ok: false, error: expect.stringContaining("shut down") });
    await client.flush();
    await client.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.reduce((sum, c) => sum + c.events.length, 0)).toBe(510);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tries a batch that was waiting for its retry one last time", async () => {
    const calls = mockFetch((_, n) => (n === 1 ? failure(503, "unavailable") : accepted()));
    const client = createClient(options);
    client.track({ event: "order_placed", company: "c1" });
    await client.flush();
    await client.shutdown();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it("does not hang when the server stays down", async () => {
    const calls = mockFetch(() => failure(503, "unavailable"));
    const client = createClient(options);
    client.track({ event: "order_placed", company: "c1" });
    await client.shutdown();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("process lifetime", () => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

  it("does not keep the process alive with its timers", async () => {
    vi.useRealTimers();
    mockFetch(() => failure(503, "unavailable"));
    const before = timers();
    const client = createClient(options);
    client.track({ event: "order_placed", company: "c1" });
    await client.flush(); // leaves the flush interval and a retry timer behind
    expect(timers()).toBe(before);
    const ref = setTimeout(() => {}, 60_000); // proves the check sees timers that do hold the process
    expect(timers()).toBe(before + 1);
    clearTimeout(ref);
    await client.shutdown();
  });
});
