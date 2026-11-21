import { startAutoTrack } from "./autotrack";
import { createLogger, silent, type Logger } from "./core/debug";
import { createQueue } from "./core/queue";
import { cleanId, resolveOrigin } from "./core/types";
import type { EventContext, IdentifyOptions, InitOptions, Properties, WireEvent } from "./core/types";

export type { IdentifyOptions, InitOptions, Properties, PropertyValue } from "./core/types";

const DEVICE_KEY = "loookin_device";

const queue = createQueue();
let options: InitOptions | undefined;
let log: Logger = silent;
let user: string | undefined;
let company: string | undefined;
/** Context known from init(): app_version and session. */
let extra: Partial<EventContext> = {};
let warnedServerKey = false;
/** True between pagehide and pageshow: the page may be gone any moment. */
let leaving = false;

/** False during server-side rendering, where every call is a no-op. */
const hasDom = () => typeof window !== "undefined" && typeof document !== "undefined";

/** crypto.randomUUID needs a secure context; plain http pages get a fallback. */
function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Anonymous mode only: the device id from localStorage, created when missing. */
function deviceId(fresh = false): string {
  let id: string | null = null;
  try {
    if (!fresh) id = localStorage.getItem(DEVICE_KEY);
  } catch {
    // storage is blocked: the id lives in memory for this page
  }
  if (!id) {
    id = uuid();
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      // see above
    }
  }
  return id;
}

function deviceType(): EventContext["device_type"] {
  const width = window.innerWidth;
  return width < 768 ? "mobile" : width < 1024 ? "tablet" : "desktop";
}

/** Sets the identity and gives it to events that were waiting for one. */
function setIdentity(nextUser: string, nextCompany?: string) {
  user = nextUser;
  company = nextCompany;
  let waiting = 0;
  for (const { event } of queue.items) {
    if (event.user) continue;
    event.user = nextUser;
    if (nextCompany) event.company = nextCompany;
    waiting++;
  }
  if (waiting) void queue.flush();
}

function init(opts: InitOptions) {
  if (!hasDom() || queue.disabled) return;
  if (options) return log("init() was already called, ignoring this call");

  const debug = createLogger(opts?.debug);
  const key = cleanId(opts?.key);
  if (key?.startsWith("ins_")) {
    // The one message that is shown even without debug.
    if (!warnedServerKey) {
      warnedServerKey = true;
      console.error(
        "[loookin] A server key (ins_...) must never be used in a browser. Nothing will be sent. Use a publishable key (pub_...) instead.",
      );
    }
    return queue.disable();
  }
  const origin = resolveOrigin(opts?.workspace);
  if (!origin || !key) {
    return debug("init() needs a workspace (slug or https origin) and a publishable key. Nothing will be sent.");
  }

  options = opts;
  log = debug;
  if (cleanId(opts.appVersion)) extra.app_version = cleanId(opts.appVersion);
  if (cleanId(opts.session)) extra.session = cleanId(opts.session);
  // Events tracked before init() did not know these yet.
  for (const { event } of queue.items) Object.assign(event.context, extra);

  queue.start({
    url: `${origin}/api/events${opts.dryRun ? "?dryRun=true" : ""}`,
    key,
    log,
    hidden: () => leaving || document.visibilityState === "hidden",
  });
  if (opts.anonymous && !user) setIdentity(deviceId());
  else if (user) void queue.flush();

  // Safari does not always fire visibilitychange when a page is closed, so
  // pagehide is watched too. A second flush finds nothing left to send.
  // The flush is forced: the page may be gone before a retry time comes.
  const onHide = () => {
    const waiting = queue.items.filter((item) => !item.event.user).length;
    if (waiting) log(`${waiting} event(s) are waiting for identify() and are lost if the page closes now`);
    void queue.flush(true);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onHide();
  });
  window.addEventListener("pagehide", () => {
    leaving = true;
    onHide();
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
  });

  if (opts.autoTrack) startAutoTrack(opts.autoTrack, guard(track));
}

function identify(id: string, opts?: IdentifyOptions) {
  if (!hasDom()) return;
  const nextUser = cleanId(id);
  if (!nextUser) return log("identify() needs a user id");
  setIdentity(nextUser, cleanId(opts?.company));
}

function track(event: string, properties?: Properties) {
  if (!hasDom() || queue.disabled) return;
  if (typeof event !== "string" || !event) return log("track() needs an event name");
  const queued: WireEvent = {
    eventId: uuid(),
    event,
    timestamp: new Date().toISOString(),
    context: { platform: "web", device_type: deviceType(), ...extra },
  };
  if (user) queued.user = user;
  if (company) queued.company = company;
  if (properties && typeof properties === "object") queued.properties = { ...properties };
  queue.push(queued);
}

function reset() {
  if (!hasDom()) return;
  user = company = undefined;
  if (options?.anonymous) user = deviceId(true);
}

/**
 * Opt-out: drops everything that is queued and sends nothing more until the
 * page reloads. A request that is already on its way cannot be recalled.
 */
function stop() {
  if (!hasDom()) return;
  user = company = undefined;
  // Also before init() and without anonymous mode: an earlier visit may have stored the id.
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // storage is blocked: there was nothing to remove
  }
  queue.disable("stop() was called. Nothing more will be sent until the page reloads.");
}

/** Nothing the SDK does may throw into the host page. */
function guard<A extends unknown[]>(fn: (...args: A) => void) {
  return (...args: A): void => {
    try {
      fn(...args);
    } catch (error) {
      log("unexpected error", error);
    }
  };
}

export const loookin = {
  /** Configures the client. A second call is ignored. */
  init: guard(init),
  /** Sets who the following events belong to and releases waiting events. */
  identify: guard(identify),
  /** Queues an event. Never throws. */
  track: guard(track),
  /** Sends the queue now, also a batch that was waiting for its retry. Resolves after the attempt; never rejects. */
  flush: (): Promise<void> => (hasDom() ? queue.flush(true) : Promise.resolve()),
  /** Forgets the identity. In anonymous mode a new device id is created. */
  reset: guard(reset),
  /** Drops the queue and stops sending until the page reloads, for example when a user opts out. */
  stop: guard(stop),
};
