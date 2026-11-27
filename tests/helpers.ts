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

export interface SurveyCall {
  url: string;
  init: RequestInit;
  body: any;
}

type SurveyHandler = (call: SurveyCall, n: number) => Response | Promise<Response>;

/** The surveys list endpoint's answer. */
export const surveyList = (surveys: unknown[] = [], ttl = 300) => json(200, { data: { surveys, ttl } });

/** Requests to `/api/sdk/surveys/**` since the last `mockFetch` call. */
export let surveyCalls: SurveyCall[] = [];

const defaultSurveyAnswer: SurveyHandler = (call) => {
  if (call.url.endsWith("/events")) return new Response(null, { status: 204 });
  if (call.url.endsWith("/responses")) return json(200, { data: { ok: true } });
  return surveyList();
};
let surveyHandler: SurveyHandler = defaultSurveyAnswer;

/** Sets how the survey endpoints answer; unanswered paths fall back to the defaults. */
export function mockSurveys(handler: (call: SurveyCall, n: number) => Response | Promise<Response> | undefined) {
  surveyHandler = (call, n) => handler(call, n) ?? defaultSurveyAnswer(call, n);
}

/**
 * Replaces global fetch. Returns the list of event requests made so far.
 * Requests to the survey endpoints go to `surveyCalls` instead, answered
 * by `mockSurveys` (by default an empty list, 204 for events, ok for responses).
 */
export function mockFetch(handler: Handler = () => accepted()): Call[] {
  const calls: Call[] = [];
  surveyCalls = [];
  surveyHandler = defaultSurveyAnswer;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/api/sdk/surveys")) {
        const call = { url, init, body: JSON.parse(init.body as string) };
        surveyCalls.push(call);
        return surveyHandler(call, surveyCalls.length);
      }
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
