import { createLogger } from "./core/debug";
import { createQueue } from "./core/queue";
import { cleanId, resolveOrigin } from "./core/types";
import type { EventContext, Properties, WireEvent } from "./core/types";

export type { EventContext, Properties, PropertyValue } from "./core/types";

export interface ClientOptions {
  /** Workspace slug ("acme") or its full origin ("https://acme.loookin.com"). */
  workspace: string;
  /** Server key ("ins_..."). */
  key: string;
  /** Log what is sent and what the server answered. */
  debug?: boolean;
  /** Let the server validate events without storing them. */
  dryRun?: boolean;
}

export interface ServerEvent {
  event: string;
  /** Your id of the customer. At least one of company and user is required. */
  company?: string;
  user?: string;
  properties?: Properties;
  /** When it happened: ISO 8601 text or a Date. Defaults to now. */
  timestamp?: string | Date;
  context?: Omit<EventContext, "platform">;
}

export type TrackResult = { ok: true } | { ok: false; error: string };

export interface Client {
  /** Queues an event. Never throws: a problem comes back as `{ ok: false, error }`. */
  track(event: ServerEvent): TrackResult;
  /** Sends the queue now. Resolves after the attempt; never rejects. */
  flush(): Promise<void>;
  /** Sends what is queued, waits for it and stops the client. */
  shutdown(): Promise<void>;
}

const fail = (error: string): TrackResult => ({ ok: false, error });

function toWireEvent(input: ServerEvent): WireEvent | string {
  if (!input || typeof input !== "object") return "track() needs an event object";
  if (typeof input.event !== "string" || !input.event) return "event name is missing";
  const company = cleanId(input.company);
  const user = cleanId(input.user);
  if (!company && !user) return "identity is missing: pass company, user or both";

  let timestamp: string;
  const at = input.timestamp ?? new Date();
  if (at instanceof Date && !Number.isNaN(at.getTime())) timestamp = at.toISOString();
  else if (typeof at === "string" && !Number.isNaN(Date.parse(at))) timestamp = at;
  else return "timestamp must be an ISO 8601 string or a valid Date";

  const event: WireEvent = {
    eventId: crypto.randomUUID(),
    event: input.event,
    timestamp,
    context: { ...input.context, platform: "server" },
  };
  if (company) event.company = company;
  if (user) event.user = user;
  if (input.properties != null) {
    if (typeof input.properties !== "object" || Array.isArray(input.properties)) return "properties must be a plain object";
    event.properties = { ...input.properties };
  }
  try {
    JSON.stringify(event);
  } catch {
    return "properties or context cannot be serialized to JSON";
  }
  return event;
}

/** Creates a client for sending events from a server. Never throws. */
export function createClient(options: ClientOptions): Client {
  const queue = createQueue();
  const origin = resolveOrigin(options?.workspace);
  const key = cleanId(options?.key);
  let closed = false;

  if (origin && key) {
    queue.start({
      url: `${origin}/api/events${options.dryRun ? "?dryRun=true" : ""}`,
      key,
      log: createLogger(options.debug),
    });
  }

  return {
    track(input) {
      try {
        if (closed) return fail("the client is shut down");
        if (!origin || !key) return fail("the client needs a workspace (slug or https origin) and a key");
        if (queue.disabled) return fail("sending is off: the server refused the key or the event quota is used up");
        const event = toWireEvent(input);
        if (typeof event === "string") return fail(event);
        queue.push(event);
        return { ok: true };
      } catch (error) {
        return fail(String(error));
      }
    },
    flush: () => queue.flush(),
    async shutdown() {
      if (closed) return;
      closed = true;
      // One last attempt, also for a batch that was waiting for its retry.
      await queue.flush(true);
      queue.disable();
    },
  };
}
