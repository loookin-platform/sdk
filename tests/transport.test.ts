import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { send } from "../src/core/transport";
import { accepted, failure, json, mockFetch, silentServer } from "./helpers";

const URL = "https://acme.loookin.com/api/events";
const BODY = '{"events":[]}';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("send", () => {
  it("posts the body with the key and without cookies", async () => {
    const calls = mockFetch();
    await send(URL, "pub_abc", BODY, true);
    expect(calls[0]!.url).toBe(URL);
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "omit",
      redirect: "error", // the key never follows a redirect
      headers: { Authorization: "Bearer pub_abc", "Content-Type": "application/json" },
      body: BODY,
    });
  });

  it("reads rejections and throttled users from a 202", async () => {
    const errors = [{ index: 1, reason: "invalid_event_name", suggestion: "report_exported" }];
    const throttled = [{ user: "u1", count: 3, retryAfter: 20 }];
    mockFetch(() => accepted({ accepted: 4, rejected: 1, errors, throttled }));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "ok", accepted: 4, errors, throttled, dryRun: false });
  });

  it("reads a dry run preview", async () => {
    const errors = [{ index: 0, reason: "missing_identity" }];
    mockFetch(() => json(200, { data: { dryRun: true, action: "create", would: { accepted: 2, rejected: 1, errors, warnings: [] } } }));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "ok", accepted: 2, errors, throttled: [], dryRun: true });
  });

  it("asks for a retry on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "retry", status: 0 });
  });

  it("asks for a retry on 5xx, also when the body is not JSON", async () => {
    mockFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "retry", status: 502, retryAfter: undefined });
  });

  it("asks for a retry after Retry-After on a rate limit 429", async () => {
    mockFetch(() => failure(429, "rate_limited", { "Retry-After": "7" }));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "retry", status: 429, retryAfter: 7 });
  });

  it("tells a used-up quota apart from a rate limit", async () => {
    mockFetch(() => failure(429, "quota_exceeded", { "Retry-After": "86400" }));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "disable", status: 429, error: "quota_exceeded" });
  });

  it.each([
    [401, "Unauthorized"],
    [403, "origin_not_allowed"],
    [403, "key_not_allowed_here"],
  ])("stops for good on %i %s", async (status, error) => {
    mockFetch(() => failure(status, error));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "disable", status, error });
  });

  it.each([
    [400, "invalid_body"],
    [400, "batch_too_large"],
    [404, "Not found"],
  ])("drops the batch on %i %s", async (status, error) => {
    mockFetch(() => failure(status, error));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "drop", status, error });
  });

  it("caps an absurd Retry-After at one hour", async () => {
    mockFetch(() => failure(429, "rate_limited", { "Retry-After": "999999" }));
    expect(await send(URL, "pub_abc", BODY, false)).toEqual({ kind: "retry", status: 429, retryAfter: 3600 });
  });

  it.each([
    ["a login page", () => new Response("<html>Sign in</html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["an empty body", () => new Response(null, { status: 204 })],
    ["JSON without data", () => json(200, { ok: true })],
    ["data of another shape", () => json(200, { data: { user: "someone" } })],
    ["a dry run without the preview", () => json(200, { data: { dryRun: true, would: null } })],
  ])("asks for a retry when a 2xx answer is %s", async (_, answer) => {
    mockFetch(answer);
    expect(await send(URL, "pub_abc", BODY, false)).toMatchObject({ kind: "retry" });
  });

  describe("a server that never answers", () => {
    beforeEach(() => void vi.useFakeTimers());

    it("gives up after 15 s and asks for a retry", async () => {
      const timeouts = silentServer();
      const result = send(URL, "pub_abc", BODY, false);
      let settled = false;
      void result.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({ kind: "retry", status: 0 });
      expect(timeouts).toEqual([15_000]);
    });
  });
});
