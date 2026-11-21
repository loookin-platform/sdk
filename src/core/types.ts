/** Property values are flat: no nested objects or arrays. */
export type PropertyValue = string | number | boolean | null;
export type Properties = Record<string, PropertyValue>;

export interface InitOptions {
  /** Workspace slug ("acme") or its full origin ("https://acme.loookin.com"). */
  workspace: string;
  /** Publishable key ("pub_..."). Server keys ("ins_...") are refused. */
  key: string;
  /** Use a random device id stored in localStorage as the user until identify(). */
  anonymous?: boolean;
  /** Sent as context.app_version. */
  appVersion?: string;
  /** Sent as context.session. */
  session?: string;
  /** Log what is sent and what the server answered. */
  debug?: boolean;
  /** Let the server validate events without storing them. */
  dryRun?: boolean;
}

export interface IdentifyOptions {
  company?: string;
}

export interface EventContext {
  platform: "web" | "server";
  device_type?: "desktop" | "mobile" | "tablet";
  app_version?: string;
  session?: string;
  /** Who triggered the action, for example "user", "api", "ai" or "system". */
  source?: string;
  os?: string;
}

/** One event as it travels to the server. */
export interface WireEvent {
  eventId: string;
  event: string;
  user?: string;
  company?: string;
  timestamp: string;
  context: EventContext;
  properties?: Properties;
}

/** A single event the server refused. `index` is its position in the batch. */
export interface Rejection {
  index: number;
  reason: string;
  suggestion?: string;
  property?: string;
  hint?: string;
}

/** A user over the per-user limit: all their events in the batch come back. */
export interface Throttled {
  user: string;
  count: number;
  retryAfter: number;
}

export type SendResult =
  | { kind: "ok"; accepted: number; errors: Rejection[]; throttled: Throttled[]; dryRun: boolean }
  /** Network error (status 0), 5xx or rate limit: send the same batch again. */
  | { kind: "retry"; status: number; retryAfter?: number }
  /** The batch itself is invalid: retrying cannot help. */
  | { kind: "drop"; status: number; error: string }
  /** The key is refused or the quota is used up: stop sending. */
  | { kind: "disable"; status: number; error: string };

/** A non-empty trimmed id, or undefined when the input is not usable. */
export function cleanId(value: unknown): string | undefined {
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/;

/**
 * Turns the `workspace` option into an origin. Accepts a slug, a host or a
 * full origin. Plain http is allowed for local development hosts only.
 */
export function resolveOrigin(workspace: unknown): string | undefined {
  const value = cleanId(workspace);
  if (!value) return undefined;
  if (/^[a-z0-9][a-z0-9-]*$/i.test(value)) return `https://${value.toLowerCase()}.loookin.com`;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol === "http:" && !LOCAL_HOST.test(url.hostname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
