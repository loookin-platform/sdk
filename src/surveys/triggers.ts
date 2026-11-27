/**
 * Triggers, evaluated in the browser. Nothing about them is sent anywhere.
 *
 * - `page_load`: the current address matches (any page, or one of the URL rules).
 * - `event`: the SDK's own `track` was called with that name for the current identity.
 * - `element_view`: an element matching the selector became visible (IntersectionObserver).
 * - `click`: an element matching the selector was clicked (one delegated listener).
 * - `time_on_page`: seconds since the last address change.
 * - `exit_intent`: the pointer left the top of the window (pointer devices only).
 *
 * Clicks, views and exit intent count until the next address change. A list
 * is read left to right and `and` binds tighter than `or`. A trigger that
 * cannot work (an invalid selector, an empty event name, an unknown kind)
 * is false and never throws. Listeners exist only while a survey needs them.
 */
import type { PageRule, SdkSurvey, Trigger } from "./types";

/** `and` binds tighter than `or`; an empty list is never satisfied. */
export function evaluateTriggers(triggers: readonly Trigger[], test: (trigger: Trigger) => boolean): boolean {
  let any = false;
  let all = true;
  triggers.forEach((trigger, i) => {
    if (i > 0 && trigger.join === "or") {
      any ||= all;
      all = true;
    }
    if (all) all = safe(() => test(trigger));
  });
  return triggers.length > 0 && (any || all);
}

function safe(fn: () => boolean): boolean {
  try {
    return fn() === true;
  } catch {
    return false;
  }
}

/**
 * A rule value with a scheme (`https://...`) is compared with the full
 * address. A value with `?` or `#` is compared with path, query and hash.
 * Anything else is compared with the path only. An empty value never matches.
 */
export function ruleMatches(rule: PageRule, loc: Pick<Location, "href" | "pathname" | "search" | "hash">): boolean {
  const value = typeof rule?.value === "string" ? rule.value.trim() : "";
  if (!value) return false;
  const target = /^https?:\/\//i.test(value) ? loc.href : /[?#]/.test(value) ? loc.pathname + loc.search + loc.hash : loc.pathname;
  if (rule.op === "equals") return target === value;
  if (rule.op === "starts_with") return target.startsWith(value);
  if (rule.op === "contains") return target.includes(value);
  return false;
}

export function pagesMatch(pages: "any" | PageRule[], loc: Pick<Location, "href" | "pathname" | "search" | "hash"> = location): boolean {
  return pages === "any" || (Array.isArray(pages) && pages.some((rule) => ruleMatches(rule, loc)));
}

/** True when a `page_load` trigger with "hide outside" no longer matches the address. */
/** The `or` groups of a list: each group holds when all of its triggers hold. */
export function orGroups(triggers: readonly Trigger[]): Trigger[][] {
  const groups: Trigger[][] = [];
  triggers.forEach((t, i) => {
    if (i === 0 || t.join === "or") groups.push([]);
    groups[groups.length - 1]!.push(t);
  });
  return groups;
}

/** A `page_load` trigger with "hide outside" whose pages the address left. */
const leftPages = (t: Trigger) => t.kind === "page_load" && t.hideOutside && t.pages !== "any" && !pagesMatch(t.pages);

/**
 * "Hide on pages that don't match": true only when every `or` group that
 * held when the survey was shown has a page rule with "hide outside" that no
 * longer matches. A survey shown through another group that does not depend
 * on the page stays.
 */
export function hiddenOutside(groups: readonly Trigger[][]): boolean {
  return groups.length > 0 && groups.every((g) => g.some(leftPages));
}

const selectorOk = new Map<string, boolean>();

/**
 * A selector `querySelector` accepts, checked once per selector. `:has(` is
 * refused: it can make every page mutation expensive to match.
 */
export function validSelector(selector: unknown): selector is string {
  if (typeof selector !== "string" || !selector.trim() || /:has\(/i.test(selector)) return false;
  let ok = selectorOk.get(selector);
  if (ok === undefined) {
    try {
      document.createDocumentFragment().querySelector(selector);
      ok = true;
    } catch {
      ok = false;
    }
    selectorOk.set(selector, ok);
  }
  return ok;
}

/** Elements observed per `element_view` selector at most. */
export const VIEW_MAX = 20;
/** Page mutations rescan for `element_view` elements at most this often (ms), with a trailing run. */
export const RESCAN_MS = 500;

export interface TriggerWatch {
  /** The surveys that may still show; listeners follow what they need. */
  watch(surveys: readonly SdkSurvey[]): void;
  /** Does this trigger hold right now? */
  test(trigger: Trigger): boolean;
  /** Are this survey's triggers satisfied right now? */
  satisfied(survey: SdkSurvey): boolean;
  /** The address changed: clicks, views and exit intent are forgotten, time on page starts again. */
  address(): void;
  /** Removes every listener, observer and timer. */
  stop(): void;
}

/**
 * Watches what the given surveys' triggers need and calls `changed` when
 * something happened that may satisfy one of them. `since` is when the page
 * loaded or last navigated: time on page counts from there.
 */
export function createTriggerWatch(events: ReadonlySet<string>, changed: () => void, since: () => number): TriggerWatch {
  const clicked = new Set<string>();
  const viewed = new Set<string>();
  let exited = false;

  let clickSelectors: string[] = [];
  let viewSelectors: string[] = [];
  let seconds: number[] = [];
  let clickOn = false;
  let exitOn = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let io: IntersectionObserver | undefined;
  let mo: MutationObserver | undefined;
  let rescanTimer: ReturnType<typeof setTimeout> | undefined;
  let lastScan = 0;
  let observed = new WeakSet<Element>();
  let counts = new Map<string, number>();

  const notify = () => {
    try {
      changed();
    } catch {
      // the caller guards itself; this only keeps a listener from throwing
    }
  };

  const onClick = (e: Event) => {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    let hit = false;
    for (const selector of clickSelectors) {
      if (!clicked.has(selector) && target.closest(selector)) {
        clicked.add(selector);
        hit = true;
      }
    }
    if (hit) notify();
  };

  const onExit = (e: MouseEvent) => {
    if (exited || e.relatedTarget || e.clientY > 0) return;
    exited = true;
    notify();
  };

  const unseen = () => viewSelectors.filter((s) => !viewed.has(s));

  function scan() {
    lastScan = Date.now();
    rescanTimer = undefined;
    if (!io) return;
    for (const selector of unseen()) {
      let n = counts.get(selector) ?? 0;
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (n >= VIEW_MAX) break;
        if (observed.has(el)) continue;
        observed.add(el);
        io.observe(el);
        n++;
      }
      counts.set(selector, n);
    }
    syncMutations();
  }

  /** Throttled: at most one rescan per RESCAN_MS, the last change always gets one. */
  function rescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(scan, Math.max(0, lastScan + RESCAN_MS - Date.now()));
  }

  /** Mutations matter only while some view selector has not been seen yet. */
  function syncMutations() {
    const need = !!io && unseen().length > 0 && typeof MutationObserver === "function";
    if (need && !mo) {
      mo = new MutationObserver(rescan);
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } else if (!need && mo) {
      mo.disconnect();
      mo = undefined;
      clearTimeout(rescanTimer);
      rescanTimer = undefined;
    }
  }

  function resetViews() {
    io?.disconnect();
    observed = new WeakSet();
    counts = new Map();
  }

  function setViews(next: string[]) {
    viewSelectors = next;
    if (!next.length || typeof IntersectionObserver !== "function") {
      resetViews();
      io = undefined;
      syncMutations();
      return;
    }
    io ??= new IntersectionObserver((entries) => {
      let hit = false;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const selector of unseen()) {
          if (entry.target.matches(selector)) {
            viewed.add(selector);
            hit = true;
          }
        }
      }
      if (hit) {
        syncMutations();
        notify();
      }
    });
    scan();
  }

  /** One timer for the nearest time-on-page threshold that is still ahead. */
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    const elapsed = Date.now() - since();
    const next = seconds.map((s) => s * 1000 - elapsed).filter((ms) => ms > 0);
    if (next.length) timer = setTimeout(notify, Math.min(...next) + 5);
  }

  function watch(next: readonly SdkSurvey[]) {
    const all = next.flatMap((s) => s.triggers);
    const of = (kind: Trigger["kind"]) =>
      [...new Set(all.flatMap((t) => (t.kind === kind && "selector" in t && validSelector(t.selector) ? [t.selector] : [])))];

    clickSelectors = of("click");
    if (clickSelectors.length > 0 !== clickOn) {
      clickOn = !clickOn;
      document[clickOn ? "addEventListener" : "removeEventListener"]("click", onClick, true);
    }

    const pointer = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
    const wantExit = pointer && all.some((t) => t.kind === "exit_intent");
    if (wantExit !== exitOn) {
      exitOn = wantExit;
      document[exitOn ? "addEventListener" : "removeEventListener"]("mouseout", onExit as EventListener);
    }

    setViews(of("element_view"));
    seconds = all.flatMap((t) => (t.kind === "time_on_page" && typeof t.seconds === "number" ? [t.seconds] : []));
    schedule();
  }

  function test(t: Trigger): boolean {
    switch (t?.kind) {
      case "page_load":
        return pagesMatch(t.pages);
      case "event":
        return typeof t.event === "string" && t.event !== "" && events.has(t.event);
      case "click":
        return validSelector(t.selector) && clicked.has(t.selector);
      case "element_view":
        return validSelector(t.selector) && viewed.has(t.selector);
      case "time_on_page":
        return typeof t.seconds === "number" && Date.now() - since() >= t.seconds * 1000;
      case "exit_intent":
        return exited;
      default:
        return false;
    }
  }

  return {
    watch,
    test,
    satisfied: (survey) => evaluateTriggers(survey.triggers, test),
    address() {
      clicked.clear();
      viewed.clear();
      exited = false;
      // Observed elements of the previous page may be gone; observe afresh.
      resetViews();
      scan();
      schedule();
    },
    stop() {
      watch([]);
      clearTimeout(timer);
    },
  };
}
