// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mockFetch } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("can be imported and called where window and document do not exist", async () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  vi.useFakeTimers();
  const calls = mockFetch();

  const { loookin } = await import("../src/browser");
  expect(() => {
    loookin.init({ workspace: "acme", key: "pub_abc", anonymous: true, debug: true });
    loookin.identify("u1", { company: "c1" });
    for (let i = 0; i < 40; i++) loookin.track("thing_done", { n: i });
    loookin.reset();
  }).not.toThrow();
  await expect(loookin.flush()).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(calls).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0); // nothing keeps a server process busy
});
