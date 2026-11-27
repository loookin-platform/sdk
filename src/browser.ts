import { startAutoTrack } from "./autotrack";
import { createLogger, silent, type Logger } from "./core/debug";
import { createQueue } from "./core/queue";
import { cleanId, resolveOrigin } from "./core/types";
import type { EventContext, IdentifyOptions, InitOptions, Properties, WireEvent } from "./core/types";
import { navigatedAt, onNavigation } from "./core/address";
import { post } from "./core/transport";
import type { SdkSurvey, SurveyHost, SurveyIdentity, SurveysController } from "./surveys/types";

export type { IdentifyOptions, InitOptions, Properties, PropertyValue } from "./core/types";

/** Where `mountSurvey` puts an Embed: an element, or a CSS selector for the first match. */
export type SurveyTarget = Element | string;
/** Removes what `mountSurvey` added; calling it again does nothing. */
export type UnmountSurvey = () => void;

const DEVICE_KEY = "loookin_device";
/** Anonymous mode only: which surveys this device has seen (written by the surveys entry). */
const SURVEYS_KEY = "loookin_surveys";

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

// Surveys. The core only asks which surveys apply and loads the renderer
// (`./surveys.js`) when the answer is not empty; the renderer decides what
// it can show.
/** Set by init() unless `surveys: false`; unset by stop(). */
let surveyHost: SurveyHost | undefined;
let language: string | undefined;
/** identify() was called (not just the anonymous device id). */
let identified = false;
let identityKey: string | undefined;
let list: { surveys: SdkSurvey[]; until: number } | undefined;
let asking: Promise<SdkSurvey[]> | undefined;
/** Bumped on every identity change: an answer for an earlier identity is dropped. */
let generation = 0;
let loading: Promise<SurveysController> | undefined;
let surveys: SurveysController | undefined;
/** Names passed to track() for the current identity, for `event` triggers. */
const tracked = new Set<string>();
/** mountSurvey() calls: key, target, and the renderer's remove function once it is loaded. */
type Mount = [string, SurveyTarget, UnmountSurvey?];
const mounts = new Set<Mount>();
const off: (() => void)[] = [];

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
  if (options) return log("init() called twice");

  const debug = createLogger(opts?.debug);
  const key = cleanId(opts?.key);
  if (key?.startsWith("ins_")) {
    // The one message that is shown even without debug.
    if (!warnedServerKey) {
      warnedServerKey = true;
      console.error(
        "[loookin] Server keys (ins_...) must never be used in a browser; nothing is sent. Use a publishable key (pub_...).",
      );
    }
    return queue.disable();
  }
  const origin = resolveOrigin(opts?.workspace);
  if (!origin || !key) {
    return debug("init() needs a workspace and a key");
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
    if (waiting) log(`${waiting} event(s) wait for identify()`);
    void queue.flush(true);
  };
  // The tab coming back may find an old survey list; only then is it asked for again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onHide();
    else if (surveyHost) {
      void freshSurveys();
      surveys?.check();
    }
  });
  window.addEventListener("pagehide", () => {
    leaving = true;
    onHide();
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
  });

  if (opts.autoTrack) startAutoTrack(opts.autoTrack, guard(track));

  const s = opts.surveys;
  if (s !== false) {
    const o = typeof s === "object" ? s : undefined;
    language = cleanId(o?.language);
    surveyHost = { origin, key, identity: surveyIdentity, fresh: freshSurveys, events: tracked, id: uuid, log, since: navigatedAt, webFonts: o?.webFonts === true, mounts };
    void askSurveys();
  }
}

function identify(id: string, opts?: IdentifyOptions) {
  if (!hasDom()) return;
  const nextUser = cleanId(id);
  if (!nextUser) return log("identify() needs a user id");
  const nextCompany = cleanId(opts?.company);
  setIdentity(nextUser, nextCompany);
  const key = `${nextUser}\n${nextCompany ?? ""}`;
  if (key === identityKey) return;
  // Events of the previous identity do not satisfy triggers of the next one.
  if (identified) tracked.clear();
  identified = true;
  identityKey = key;
  refreshSurveys();
}

/** Who the survey requests are for. Without identify() only in anonymous mode. */
function surveyIdentity(): SurveyIdentity | undefined {
  if (identified) return { user, company }; // an undefined company is left out of the JSON
  return options?.anonymous ? { anonymous: true } : undefined;
}

/** Asks which surveys apply now. Never rejects (post() never does); a failure is an empty list. */
function askSurveys(): Promise<SdkSurvey[]> {
  const host = surveyHost;
  const identity = surveyIdentity();
  if (!host || !identity) return Promise.resolve([]);
  const asked = generation;
  const body = JSON.stringify({ identity, schema: 1, language });
  return (asking ??= post(`${host.origin}/api/sdk/surveys`, host.key, body, false, 5000)
    .then((answer) => {
      if (asked !== generation) return [];
      asking = undefined;
      const data = answer?.res.ok ? answer.json?.data : undefined;
      const got: SdkSurvey[] = Array.isArray(data?.surveys) ? data.surveys : [];
      const mine = (list = { surveys: got, until: Date.now() + (data?.ttl > 0 ? data.ttl : 300) * 1000 });
      // A late import must not apply a list that was replaced meanwhile.
      if (got.length) loadSurveys().then((s) => list === mine && s.update(got), noop);
      else surveys?.update([]);
      return got;
    }));
}

/** The list, asked again first when it is older than its ttl. */
function freshSurveys(): Promise<SdkSurvey[]> {
  return list && Date.now() < list.until ? Promise.resolve(list.surveys) : askSurveys();
}

function loadSurveys(): Promise<SurveysController> {
  // A failed import is not tried again on this page.
  return (loading ??= import("./surveys.js").then((m) => {
    off.push(
      onNavigation(() => {
        void freshSurveys();
        surveys?.address();
      }),
    );
    return (surveys = m.startSurveys(surveyHost!));
  }));
}

/** A new identity, or none: the open survey closes and the list is asked for again. */
function refreshSurveys() {
  generation++;
  asking = list = undefined;
  surveys?.close();
  void askSurveys();
}

/** Async: whatever goes wrong is a promise of `false`, never a throw. */
async function showSurvey(key: string): Promise<boolean> {
  try {
    return !!surveyHost && (await freshSurveys()).some((s) => s?.key === key) && (await (await loadSurveys()).show(key));
  } catch {
    return false;
  }
}

/**
 * Registers an Embed; the renderer fills `target` while the survey applies.
 * The renderer loads with the first non-empty list, so a mount alone loads nothing.
 */
function mountSurvey(key: string, target: SurveyTarget): UnmountSurvey {
  const mount: Mount = [key, target];
  // Before the renderer loads it takes these over (and the core lets go of the targets).
  if (hasDom() && !queue.disabled) surveys ? (mount[2] = surveys.mount(key, target)) : mounts.add(mount);
  return () => {
    mounts.delete(mount);
    mount[2]?.();
  };
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
  if (surveyHost) {
    tracked.add(event);
    surveys?.track(event);
  }
}

function reset() {
  if (!hasDom()) return;
  user = company = undefined;
  if (options?.anonymous) user = deviceId(true);
  identified = false;
  identityKey = undefined;
  tracked.clear();
  refreshSurveys();
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
    localStorage.removeItem(SURVEYS_KEY);
  } catch {
    // storage is blocked: there was nothing to remove
  }
  queue.disable("stopped");
  surveyHost = undefined;
  refreshSurveys();
  surveys?.stop();
  mounts.clear();
  for (const remove of off.splice(0)) remove();
}

const noop = () => {};

/** Nothing the SDK does may throw into the host page. */
function guard<A extends unknown[]>(fn: (...args: A) => void) {
  return (...args: A): void => {
    try {
      fn(...args);
    } catch (error) {
      log("error", error);
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
  /** Shows a survey by its key now, without its triggers. Resolves to whether it was shown; never rejects. */
  showSurvey,
  /**
   * Puts an Embed survey into `target` (an element or a CSS selector) when it
   * applies to the current identity, and keeps it there across identity
   * changes. Returns the function that removes it. Never throws.
   */
  mountSurvey(key: string, target: SurveyTarget): UnmountSurvey {
    try {
      return mountSurvey(key, target);
    } catch {
      return noop;
    }
  },
};
