import type { Rejection, SendResult, Throttled } from "./types";

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** A server that accepts the request and never answers must not block the queue. */
export const TIMEOUT_MS = 15_000;
/** No answer may put events on hold for longer than this. */
export const MAX_WAIT_SECONDS = 3600;

/** A delay the server asked for, capped; undefined when it is not a positive number. */
export function waitSeconds(value: unknown): number | undefined {
  const seconds = Number(value);
  return seconds > 0 ? Math.min(seconds, MAX_WAIT_SECONDS) : undefined;
}

/**
 * Sends one batch and reduces the answer to what the queue has to do next.
 * Never throws: a failed request, one that timed out and a 2xx answer that
 * is not the ingest's own are `retry` results.
 */
export async function send(url: string, key: string, body: string, keepalive: boolean): Promise<SendResult> {
  let res: Response;
  let json: any;
  try {
    res = await fetch(url, {
      method: "POST",
      keepalive,
      credentials: "omit",
      // The key and the events must not follow a redirect, for example to a login page.
      redirect: "error",
      signal: AbortSignal.timeout?.(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
    });
    json = await res.json().catch(() => null);
  } catch {
    return { kind: "retry", status: 0 };
  }

  const status = res.status;
  if (res.ok) {
    // A dry run answers 200 with the preview under `data.would`.
    const data = json?.data;
    const result = data?.would ?? data;
    // A login wall or a proxy page answers 2xx too: only the ingest's own shape counts.
    if (typeof result?.accepted !== "number") return { kind: "retry", status };
    return {
      kind: "ok",
      accepted: result.accepted,
      errors: list<Rejection>(result.errors),
      throttled: list<Throttled>(result.throttled),
      dryRun: data.dryRun === true,
    };
  }

  const error = typeof json?.error === "string" ? json.error : String(status);
  // A used-up quota is a 429 too, but waiting a few seconds will not help.
  if (status === 401 || status === 403 || error === "quota_exceeded") return { kind: "disable", status, error };
  if (status === 429 || status >= 500) {
    return { kind: "retry", status, retryAfter: waitSeconds(res.headers.get("Retry-After")) };
  }
  return { kind: "drop", status, error };
}
