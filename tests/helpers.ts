import { vi } from "vitest";
import type { WireEvent } from "../src/core/types";

export interface Call {
  url: string;
  init: RequestInit;
  body: string;
  events: WireEvent[];
}

type Handler = (call: Call, n: number) => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

/** The server's 202 answer; pass `errors` or `throttled` to shape it. */
export const accepted = (extra: Record<string, unknown> = {}) =>
  json(202, { data: { batchId: "b1", accepted: 0, rejected: 0, errors: [], warnings: [], ...extra } });

export const failure = (status: number, error: string, headers?: Record<string, string>) =>
  json(status, { error, message: "..." }, headers);

/** Replaces global fetch. Returns the list of requests made so far. */
export function mockFetch(handler: Handler = () => accepted()): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body as string;
      const call = { url, init, body, events: JSON.parse(body).events as WireEvent[] };
      calls.push(call);
      return handler(call, calls.length);
    }),
  );
  return calls;
}

let n = 0;
export function event(overrides: Partial<WireEvent> = {}): WireEvent {
  n++;
  return {
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    event: "thing_done",
    user: "u1",
    timestamp: "2026-01-01T00:00:00.000Z",
    context: { platform: "web" },
    ...overrides,
  };
}

/** A request whose answer the test gives later, to keep it in flight. */
export function gate() {
  let open!: (res: Response) => void;
  const answer = new Promise<Response>((resolve) => (open = resolve));
  return { answer, open };
}

/**
 * A server that accepts the request and never answers. Makes
 * AbortSignal.timeout run on the fake clock; returns the timeouts asked for.
 */
export function silentServer(): number[] {
  const timeouts: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    timeouts.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    ),
  );
  return timeouts;
}
