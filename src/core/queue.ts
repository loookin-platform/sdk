import { describeDisabled, describeRejection, silent, type Logger } from "./debug";
import { send, waitSeconds } from "./transport";
import type { WireEvent } from "./types";

export const MAX_QUEUE = 1000;
export const FLUSH_AT = 30;
export const FLUSH_MS = 10_000;
export const MAX_BATCH_EVENTS = 500;
/** The server takes 1 MiB; the margin covers the envelope. */
export const MAX_BATCH_BYTES = 1_000_000;
/** Browsers cap keepalive bodies at 64 KiB, so a hidden page sends less. */
export const MAX_KEEPALIVE_BYTES = 60_000;
const MAX_BACKOFF_SECONDS = 60;
/** For a throttled user when the server did not say how long to wait. */
const THROTTLE_SECONDS = 30;

export interface QueueConfig {
  /** Full endpoint URL, including `?dryRun=true` when wanted. */
  url: string;
  key: string;
  log?: Logger;
  /** True while the page is hidden: batches must fit a keepalive request. */
  hidden?: () => boolean;
}

export interface QueueItem {
  event: WireEvent;
  /** Do not send before this time (ms). Set when the user was throttled. */
  notBefore: number;
}

interface Batch {
  items: QueueItem[];
  body: string;
  bytes: number;
  attempt: number;
  /** Earliest time of the next attempt (ms). */
  at: number;
  /** True while its request is on the way. */
  flying: boolean;
}

const encoder = new TextEncoder();

/** The name the server uses for an event's owner in `throttled`. */
const identityOf = (e: WireEvent) => e.user ?? `company:${e.company}`;

export type Queue = ReturnType<typeof createQueue>;

/**
 * In-memory queue with batching, retry and throttling. Events without an
 * identity stay queued until the caller fills one in.
 */
export function createQueue() {
  let items: QueueItem[] = [];
  let config: QueueConfig | undefined;
  let log: Logger = silent;
  /** Batches taken off the queue and not settled yet: in flight or waiting for a retry. */
  const out = new Set<Batch>();
  let held: Batch | undefined; // the main loop's batch: in flight or waiting for its retry
  let running: Promise<void> | undefined;
  let side: Promise<void> | undefined; // the extra loop of a page that is going away
  let interval: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disabled = false;

  function trim() {
    let over = items.length - MAX_QUEUE;
    for (const batch of out) over += batch.items.length;
    if (over > 0) {
      items.splice(0, over);
      log(`queue is full, dropped the ${over} oldest event(s)`);
    }
  }

  /** The largest body the next batch may have. */
  function limit(): number {
    if (!config?.hidden?.()) return MAX_BATCH_BYTES;
    // Browsers count all keepalive requests in flight against one budget.
    let free = MAX_KEEPALIVE_BYTES;
    for (const batch of out) if (batch.flying && batch.bytes <= MAX_KEEPALIVE_BYTES) free -= batch.bytes;
    return free;
  }

  /** Takes the next batch of sendable events off the queue, oldest first. */
  function take(now: number): Batch | undefined {
    const max = limit();
    const picked: QueueItem[] = [];
    const parts: string[] = [];
    const rest: QueueItem[] = [];
    let bytes = 13; // {"events":[]}
    let full = false;
    for (const item of items) {
      const e = item.event;
      if (!full && (e.user || e.company) && item.notBefore <= now) {
        let json: string;
        try {
          json = JSON.stringify(e);
        } catch {
          continue; // not serializable: drop it rather than block the queue
        }
        const size = encoder.encode(json).length + 1;
        // An event larger than the limit still goes out, alone, unless a
        // request in flight has used up a part of the keepalive budget.
        if (bytes + size <= max || (picked.length === 0 && max >= MAX_KEEPALIVE_BYTES)) {
          picked.push(item);
          parts.push(json);
          bytes += size;
          full = picked.length >= MAX_BATCH_EVENTS;
          continue;
        }
        full = true;
      }
      rest.push(item);
    }
    if (picked.length === 0) return undefined;
    items = rest;
    const batch = { items: picked, body: `{"events":[${parts.join(",")}]}`, bytes, attempt: 0, at: 0, flying: false };
    out.add(batch);
    return batch;
  }

  /** Puts a batch's events back at the front of the queue. */
  function release(batch: Batch) {
    out.delete(batch);
    if (held === batch) held = undefined;
    items.unshift(...batch.items);
  }

  function disable(reason?: string) {
    disabled = true;
    items = [];
    out.clear();
    held = undefined;
    clearInterval(interval);
    clearTimeout(retryTimer);
    if (reason) log(reason);
  }

  /** Sends one batch and acts on the answer. True when the next batch may follow. */
  async function deliver(cfg: QueueConfig, batch: Batch): Promise<boolean> {
    batch.flying = true;
    const result = await send(cfg.url, cfg.key, batch.body, batch.bytes <= MAX_KEEPALIVE_BYTES);
    batch.flying = false;
    if (disabled) return false;

    if (result.kind === "retry") {
      const seconds = result.retryAfter ?? Math.min(MAX_BACKOFF_SECONDS, 2 ** batch.attempt);
      const delay = Math.ceil(seconds * 1000 * (1 + Math.random() * 0.25));
      log(
        result.status
          ? `server answered ${result.status}, retrying ${batch.items.length} event(s) in ${delay} ms`
          : `request failed (offline, timeout, or CORS: is the origin allowed?), retrying ${batch.items.length} event(s) in ${delay} ms`,
      );
      // Only one batch waits for a retry; another one goes back to the queue behind it.
      if (held && held !== batch) {
        release(batch);
        return false;
      }
      held = batch;
      batch.attempt++;
      batch.at = Date.now() + delay;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flush, delay);
      (retryTimer as { unref?: () => void }).unref?.();
      return false;
    }

    out.delete(batch);
    if (held === batch) held = undefined;
    if (result.kind === "disable") {
      disable(describeDisabled(result.status, result.error));
      return false;
    }
    if (result.kind === "drop") {
      log(`server refused the batch (${result.status} ${result.error}), dropped ${batch.items.length} event(s)`);
      return true;
    }

    log(
      result.dryRun
        ? `dry run: ${batch.items.length} event(s) checked, ${result.accepted} would be accepted, nothing was stored`
        : `sent ${batch.items.length} event(s), ${result.accepted} accepted`,
      batch.items.map((item) => item.event),
    );
    const rejected = new Set<number>();
    for (const r of result.errors) {
      rejected.add(r.index);
      log(describeRejection(batch.items[r.index]?.event, r));
    }
    // Throttled users wait; everyone else's events are already accepted.
    for (const t of result.throttled) {
      const seconds = waitSeconds(t.retryAfter) ?? THROTTLE_SECONDS;
      const until = Date.now() + seconds * 1000;
      const back = batch.items.filter((item, i) => !rejected.has(i) && identityOf(item.event) === t.user);
      for (const item of back) item.notBefore = until;
      items.unshift(...back);
      log(`user "${t.user}" is throttled, ${back.length} event(s) go again in ${seconds} s`);
    }
    trim();
    return true;
  }

  /** The main loop. `force` does not wait for a retry time. */
  async function run(cfg: QueueConfig, force: boolean): Promise<void> {
    while (!disabled) {
      // A waiting batch that is too big for a hidden page's keepalive request is split again.
      if (force && held && held.bytes > MAX_KEEPALIVE_BYTES && cfg.hidden?.()) release(held);
      const batch = held ?? take(Date.now());
      if (!batch || (!force && batch.at > Date.now())) return;
      held = batch;
      if (!(await deliver(cfg, batch))) return;
    }
  }

  /** Sends what is not part of the request in flight, next to it. */
  async function drain(cfg: QueueConfig): Promise<void> {
    while (!disabled) {
      const batch = take(Date.now());
      if (!batch || !(await deliver(cfg, batch))) return;
    }
  }

  const settle = (work: Promise<void>) => work.catch((error) => log("error", error));

  /**
   * Sends what can be sent now. Resolves after the attempt; never rejects.
   * `force` also sends a batch that is waiting for its retry time. On a
   * hidden page it does not wait for a request in flight either.
   */
  function flush(force?: unknown): Promise<void> {
    if (!config || disabled) return Promise.resolve();
    const cfg = config;
    if (force === true && running) {
      if (!cfg.hidden?.()) return running.then(() => flush(true));
      side ??= settle(drain(cfg)).finally(() => {
        side = undefined;
      });
      return Promise.all([running, side]).then(() => {});
    }
    running ??= settle(run(cfg, force === true)).finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    /** Queued events, oldest first. The caller may fill in identity. */
    get items(): readonly QueueItem[] {
      return items;
    },
    get disabled() {
      return disabled;
    },
    push(event: WireEvent) {
      if (disabled) return;
      items.push({ event, notBefore: 0 });
      trim();
      if (items.length >= FLUSH_AT) void flush();
    },
    /** Starts sending: on a timer, at FLUSH_AT queued events and on flush(). */
    start(cfg: QueueConfig) {
      if (config || disabled) return;
      config = cfg;
      log = cfg.log ?? silent;
      interval = setInterval(flush, FLUSH_MS);
      (interval as { unref?: () => void }).unref?.();
    },
    flush,
    disable,
  };
}
