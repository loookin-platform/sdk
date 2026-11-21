import { describeDisabled, describeRejection, silent, type Logger } from "./debug";
import { send } from "./transport";
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
  let held: Batch | undefined; // the batch in flight or waiting for its retry
  let running: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disabled = false;

  function trim() {
    const over = items.length + (held?.items.length ?? 0) - MAX_QUEUE;
    if (over > 0) {
      items.splice(0, over);
      log(`queue is full, dropped the ${over} oldest event(s)`);
    }
  }

  /** Takes the next batch of sendable events off the queue, oldest first. */
  function take(now: number): Batch | undefined {
    const limit = config?.hidden?.() ? MAX_KEEPALIVE_BYTES : MAX_BATCH_BYTES;
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
        // An event larger than the limit still goes out, alone.
        if (picked.length === 0 || bytes + size <= limit) {
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
    return { items: picked, body: `{"events":[${parts.join(",")}]}`, bytes, attempt: 0, at: 0 };
  }

  function disable(reason?: string) {
    disabled = true;
    items = [];
    held = undefined;
    clearInterval(interval);
    clearTimeout(retryTimer);
    if (reason) log(reason);
  }

  async function run(cfg: QueueConfig): Promise<void> {
    while (!disabled) {
      const batch = held ?? take(Date.now());
      if (!batch || batch.at > Date.now()) return;
      held = batch;
      const result = await send(cfg.url, cfg.key, batch.body, batch.bytes <= MAX_KEEPALIVE_BYTES);
      if (disabled) return;

      if (result.kind === "retry") {
        const seconds = result.retryAfter ?? Math.min(MAX_BACKOFF_SECONDS, 2 ** batch.attempt);
        const delay = Math.ceil(seconds * 1000 * (1 + Math.random() * 0.25));
        batch.attempt++;
        batch.at = Date.now() + delay;
        retryTimer = setTimeout(flush, delay);
        (retryTimer as { unref?: () => void }).unref?.();
        log(
          result.status
            ? `server answered ${result.status}, retrying ${batch.items.length} event(s) in ${delay} ms`
            : `request failed (offline, or blocked by CORS when the origin is not allowed), retrying ${batch.items.length} event(s) in ${delay} ms`,
        );
        return;
      }

      held = undefined;
      if (result.kind === "disable") return disable(describeDisabled(result.status, result.error));
      if (result.kind === "drop") {
        log(`server refused the batch (${result.status} ${result.error}), dropped ${batch.items.length} event(s)`);
        continue;
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
        const until = Date.now() + t.retryAfter * 1000;
        const back = batch.items.filter((item, i) => !rejected.has(i) && identityOf(item.event) === t.user);
        for (const item of back) item.notBefore = until;
        items.unshift(...back);
        log(`user "${t.user}" is throttled, ${back.length} event(s) go again in ${t.retryAfter} s`);
      }
      trim();
    }
  }

  /** Sends what can be sent now. Resolves after the attempt; never rejects. */
  function flush(): Promise<void> {
    if (!config || disabled) return Promise.resolve();
    const cfg = config;
    running ??= run(cfg)
      .catch((error) => log("unexpected error", error))
      .finally(() => {
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
