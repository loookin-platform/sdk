import type { Rejection, SendResult, Throttled } from "./types";

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/**
 * Sends one batch and reduces the answer to what the queue has to do next.
 * Never throws: a failed request is a `retry` result.
 */
export async function send(url: string, key: string, body: string, keepalive: boolean): Promise<SendResult> {
  let res: Response;
  let json: any;
  try {
    res = await fetch(url, {
      method: "POST",
      keepalive,
      credentials: "omit",
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
    const data = json?.data ?? {};
    const result = data.would ?? data;
    return {
      kind: "ok",
      accepted: Number(result.accepted) || 0,
      errors: list<Rejection>(result.errors),
      throttled: list<Throttled>(result.throttled),
      dryRun: data.dryRun === true,
    };
  }

  const error = typeof json?.error === "string" ? json.error : String(status);
  // A used-up quota is a 429 too, but waiting a few seconds will not help.
  if (status === 401 || status === 403 || error === "quota_exceeded") return { kind: "disable", status, error };
  if (status === 429 || status >= 500) {
    const seconds = Number(res.headers.get("Retry-After"));
    return { kind: "retry", status, retryAfter: seconds > 0 ? seconds : undefined };
  }
  return { kind: "drop", status, error };
}
