// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { accepted, failure, json, mockFetch } from "./helpers";
import { hidePage, loadSdk, setupPage } from "./page";

const options = { workspace: "acme", key: "pub_abc" };

setupPage();

function spyConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
}

/** Everything written to the console, as one string. */
const output = (spies: ReturnType<typeof spyConsole>) => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

describe("debug: true", () => {
  it("shows a rejected event with the server's reason and suggestion", async () => {
    const spies = spyConsole();
    mockFetch(() =>
      accepted({
        accepted: 1,
        rejected: 2,
        errors: [
          { index: 0, reason: "invalid_event_name", suggestion: "report_exported" },
          { index: 2, reason: "invalid_property_value", property: "filters" },
        ],
      }),
    );
    const loookin = await loadSdk();
    loookin.init({ ...options, debug: true });
    loookin.identify("u1");
    loookin.track("Report Exported");
    loookin.track("report_opened");
    loookin.track("report_filtered", { filters: { nested: true } } as never);
    await loookin.flush();

    const text = output(spies);
    expect(text).toContain("sent 3 event(s), 1 accepted");
    expect(text).toContain('rejected \\"Report Exported\\": invalid_event_name, suggestion: report_exported');
    expect(text).toContain('rejected \\"report_filtered\\": invalid_property_value (filters)');
  });

  it("reports an origin that is not allowed once and stops trying", async () => {
    const spies = spyConsole();
    const calls = mockFetch(() => failure(403, "origin_not_allowed"));
    const loookin = await loadSdk();
    loookin.init({ ...options, debug: true });
    loookin.identify("u1");
    loookin.track("thing_done");
    await loookin.flush();
    for (let i = 0; i < 40; i++) loookin.track("thing_done");
    hidePage();
    await loookin.flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(calls).toHaveLength(1);
    const lines = spies.flatMap((spy) => spy.mock.calls).filter((args) => String(args[1]).includes("allowed origins"));
    expect(lines).toHaveLength(1);
  });

  it("reports throttling and retries", async () => {
    const spies = spyConsole();
    mockFetch((_, n) =>
      n === 1 ? failure(503, "unavailable") : accepted({ throttled: [{ user: "u1", count: 1, retryAfter: 30 }] }),
    );
    const loookin = await loadSdk();
    loookin.init({ ...options, debug: true });
    loookin.identify("u1");
    loookin.track("thing_done");
    await loookin.flush();
    await vi.advanceTimersByTimeAsync(1_000);

    const text = output(spies);
    expect(text).toContain("server answered 503, retrying 1 event(s) in 1000 ms");
    expect(text).toContain('user \\"u1\\" is throttled, 1 event(s) go again in 30 s');
  });

  it("says why nothing is sent when init() is incomplete", async () => {
    const spies = spyConsole();
    const loookin = await loadSdk();
    loookin.init({ workspace: "acme", debug: true } as never);
    expect(output(spies)).toContain("init() needs a workspace");
  });
});

describe("dryRun: true", () => {
  it("lets the server validate, shows the preview and does not send the events again", async () => {
    const spies = spyConsole();
    const calls = mockFetch(() =>
      json(200, {
        data: {
          dryRun: true,
          action: "create",
          would: { accepted: 1, rejected: 1, errors: [{ index: 1, reason: "invalid_event_name", suggestion: "bad_name" }], warnings: [] },
        },
      }),
    );
    const loookin = await loadSdk();
    loookin.init({ ...options, debug: true, dryRun: true });
    loookin.identify("u1");
    loookin.track("good_name");
    loookin.track("Bad Name");
    await loookin.flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://acme.loookin.com/api/events?dryRun=true");
    const text = output(spies);
    expect(text).toContain("dry run: 2 event(s) checked, 1 would be accepted, nothing was stored");
    expect(text).toContain('rejected \\"Bad Name\\": invalid_event_name, suggestion: bad_name');
    expect(text).not.toContain("sent 2 event(s)");
  });
});

describe("debug off", () => {
  it.each([
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 500", () => failure(500, "boom")],
    ["a rate limit", () => failure(429, "rate_limited", { "Retry-After": "1" })],
    ["an invalid batch", () => failure(400, "invalid_body")],
    ["a refused key", () => failure(401, "Unauthorized")],
    ["a refused origin", () => failure(403, "origin_not_allowed")],
    ["a used-up quota", () => failure(429, "quota_exceeded")],
    ["rejected and throttled events", () => accepted({ errors: [{ index: 0, reason: "pii_detected" }], throttled: [{ user: "u1", count: 1, retryAfter: 1 }] })],
  ])("prints nothing on %s", async (_, respond) => {
    const spies = spyConsole();
    const calls = mockFetch(() => respond());
    const loookin = await loadSdk();
    loookin.init(options);
    loookin.init(options);
    loookin.track(undefined as never);
    loookin.identify("u1");
    for (let i = 0; i < 1100; i++) loookin.track("thing_done", { n: i });
    hidePage();
    await loookin.flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(calls.length).toBeGreaterThan(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
