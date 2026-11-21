import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueue } from "../src/core/queue";
import { accepted, event, failure, mockFetch } from "./helpers";

const config = { url: "https://acme.loookin.com/api/events", key: "pub_abc" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0); // no jitter unless a test wants it
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("batching", () => {
  it("sends nothing before the interval and one request after it", async () => {
    const calls = mockFetch();
    const queue = createQueue();
    queue.start(config);
    for (let i = 0; i < 20; i++) queue.push(event());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.events).toHaveLength(20);
    expect(queue.items).toHaveLength(0);
  });

  it("sends as soon as 30 events are queued", async () => {
    const calls = mockFetch();
    const queue = createQueue();
    queue.start(config);
    for (let i = 0; i < 29; i++) queue.push(event());
    expect(calls).toHaveLength(0);
    queue.push(event());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.events).toHaveLength(30);
  });

  it("splits a long queue into batches of at most 500 events", async () => {
    const calls = mockFetch();
    const queue = createQueue();
    for (let i = 0; i < 1000; i++) queue.push(event());
    queue.start(config);
    await queue.flush();
    expect(calls.map((c) => c.events.length)).toEqual([500, 500]);
  });

  it("keeps a batch under 1 MB", async () => {
    const calls = mockFetch();
    const queue = createQueue();
    for (let i = 0; i < 300; i++) queue.push(event({ properties: { note: "x".repeat(5_000) } }));
    queue.start(config);
    await queue.flush();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.reduce((sum, c) => sum + c.events.length, 0)).toBe(300);
    for (const call of calls) {
      expect(new TextEncoder().encode(call.body).length).toBeLessThanOrEqual(1_000_000);
      expect(call.init.keepalive).toBe(false);
    }
  });

  it("keeps batches from a hidden page under 60 kB and sends the rest after", async () => {
    const calls = mockFetch();
    const queue = createQueue();
    for (let i = 0; i < 25; i++) queue.push(event({ properties: { note: "ž".repeat(2_500) } })); // 2 bytes per char
    queue.start({ ...config, hidden: () => true });
    await queue.flush();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.reduce((sum, c) => sum + c.events.length, 0)).toBe(25);
    for (const call of calls) {
      expect(new TextEncoder().encode(call.body).length).toBeLessThanOrEqual(60_000);
      expect(call.init.keepalive).toBe(true);
    }
  });

  it("holds events without an identity", async () => {
    const calls = mockFetch();
    const queue = createQueue();
    queue.start(config);
    queue.push(event({ user: undefined }));
    queue.push(event());
    await queue.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.events).toHaveLength(1);
    expect(queue.items).toHaveLength(1);
  });

  it("drops the oldest events over 1000", () => {
    const queue = createQueue();
    const events = Array.from({ length: 1005 }, () => event());
    for (const e of events) queue.push(e);
    expect(queue.items).toHaveLength(1000);
    expect(queue.items[0]!.event.eventId).toBe(events[5]!.eventId);
    expect(queue.items[999]!.event.eventId).toBe(events[1004]!.eventId);
  });

  it("does nothing before start()", async () => {
    const calls = mockFetch();
    const queue = createQueue();
    for (let i = 0; i < 40; i++) queue.push(event());
    await queue.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);
    expect(queue.items).toHaveLength(40);
  });
});

describe("retry", () => {
  it("sends the identical batch again with 1, 2, 4 s backoff", async () => {
    const calls = mockFetch((_, n) => (n <= 3 ? failure(503, "unavailable") : accepted()));
    const queue = createQueue();
    queue.start(config);
    queue.push(event());
    queue.push(event());
    await queue.flush();
    expect(calls).toHaveLength(1);

    queue.push(event()); // arrives during the outage: must not join the retried batch
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(5); // the retry, then the event that waited

    expect(new Set(calls.slice(0, 4).map((c) => c.body)).size).toBe(1);
    expect(calls[4]!.events).toHaveLength(1);
    expect(queue.items).toHaveLength(0);
  });

  it("retries after a network error", async () => {
    let online = false;
    const calls = mockFetch(() => {
      if (!online) throw new TypeError("Failed to fetch");
      return accepted();
    });
    const queue = createQueue();
    queue.start(config);
    queue.push(event());
    await queue.flush();
    online = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it("never waits longer than 60 s plus jitter", async () => {
    vi.mocked(Math.random).mockReturnValue(1); // the largest jitter: 25 %
    const times: number[] = [];
    mockFetch(() => {
      times.push(Date.now());
      return failure(500, "boom");
    });
    const queue = createQueue();
    queue.start(config);
    queue.push(event());
    await queue.flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps.slice(0, 7)).toEqual([1_250, 2_500, 5_000, 10_000, 20_000, 40_000, 75_000]);
    expect(Math.max(...gaps)).toBe(75_000);
  });

  it("honours Retry-After on a rate limit", async () => {
    const calls = mockFetch((_, n) => (n === 1 ? failure(429, "rate_limited", { "Retry-After": "12" }) : accepted()));
    const queue = createQueue();
    queue.start(config);
    queue.push(event());
    await queue.flush();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it("drops a batch the server calls invalid and carries on", async () => {
    const calls = mockFetch((_, n) => (n === 1 ? failure(400, "invalid_body") : accepted()));
    const queue = createQueue();
    queue.start(config);
    queue.push(event());
    await queue.flush();
    queue.push(event());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.events).toHaveLength(1);
    expect(calls[1]!.body).not.toBe(calls[0]!.body);
  });
});

describe("disabled state", () => {
  it.each([
    [401, "Unauthorized"],
    [403, "origin_not_allowed"],
    [429, "quota_exceeded"],
  ])("stops sending for good after %i %s", async (status, error) => {
    const calls = mockFetch(() => failure(status, error, { "Retry-After": "5" }));
    const queue = createQueue();
    queue.start(config);
    queue.push(event());
    await queue.flush();
    expect(queue.disabled).toBe(true);

    for (let i = 0; i < 40; i++) queue.push(event());
    await queue.flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(1);
    expect(queue.items).toHaveLength(0);
  });
});

describe("throttled users", () => {
  it("sends a throttled user's events again later without holding others back", async () => {
    const calls = mockFetch((_, n) =>
      n === 1 ? accepted({ accepted: 1, throttled: [{ user: "slow", count: 2, retryAfter: 30 }] }) : accepted(),
    );
    const queue = createQueue();
    queue.start(config);
    const slow = [event({ user: "slow" }), event({ user: "slow" })];
    queue.push(slow[0]!);
    queue.push(event({ user: "fast" }));
    queue.push(slow[1]!);
    await queue.flush();
    expect(calls).toHaveLength(1);
    expect(queue.items.map((item) => item.event.eventId)).toEqual(slow.map((e) => e.eventId));

    queue.push(event({ user: "fast" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.events.map((e) => e.user)).toEqual(["fast"]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2); // 20 s in: still waiting
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.events.map((e) => e.eventId)).toEqual(slow.map((e) => e.eventId));
  });

  it("does not send again an event the server rejected", async () => {
    const calls = mockFetch((_, n) =>
      n === 1
        ? accepted({ errors: [{ index: 0, reason: "invalid_event_name" }], throttled: [{ user: "slow", count: 1, retryAfter: 5 }] })
        : accepted(),
    );
    const queue = createQueue();
    queue.start(config);
    queue.push(event({ user: "slow", event: "Bad Name" }));
    queue.push(event({ user: "slow" }));
    await queue.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls[1]!.events.map((e) => e.event)).toEqual(["thing_done"]);
  });
});
