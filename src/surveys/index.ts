/**
 * The surveys entry (`@loookin/sdk/surveys`). The core entry loads it with a
 * dynamic import when the workspace returned at least one survey, and talks
 * to it through `startSurveys`. This entry decides what it can show:
 * formats, schema and the shape of every definition.
 *
 * At most one Popup, Modal or Banner is on screen (the slot). They are tried
 * in the order the server returned them (already sorted by priority); after
 * one was shown, the next waits for the next address change. Tooltips do
 * not compete for the slot: each shows when its triggers hold and its anchor
 * is on the page, at most one per anchor. Embeds have no triggers: they
 * fill the elements passed to `mount` while the list has them.
 *
 * A survey shown on this page is not shown again by its triggers until the
 * page reloads (in anonymous mode not on later visits either, see
 * memory.ts). Two tabs do not show the same Popup, Modal, Banner or Tooltip:
 * a `BroadcastChannel` tells the others.
 *
 * A survey is drawn invisibly first, then `survey_viewed` is sent, and only
 * when the server accepted it does the survey become visible: an exposure
 * the server did not record would drop the rest of the run. An Embed sends
 * `survey_viewed` when it is in the viewport, not when it is mounted, and a
 * Tooltip only once its anchor is visible. A survey whose view was refused
 * (or that could not be drawn) is not tried again for this identity on this
 * page, so a refused view is never sent in a loop.
 *
 * While the page shows a modal dialog of its own (`:modal`), nothing new
 * shows, and an open Popup, Banner or Tooltip hides until it closes: outside
 * the dialog it would be inert.
 */
import { sendEvent, sendResponse, type SurveyEvent } from "./client";
import { allowed, remember } from "./memory";
import { prepareSurvey, type Placement, type Run } from "./render/runner";
import { anchorVisible } from "./render/tooltip";
import { createTriggerWatch, evaluateTriggers, hiddenOutside, orGroups, RESCAN_MS, validSelector } from "./triggers";
import { competes, isRenderable, type SdkSurvey, type SurveyHost, type SurveysController, type Trigger } from "./types";

export type { SdkSurvey, SurveyHost, SurveysController } from "./types";

const CHANNEL = "loookin-surveys";
/** Share of an Embed (or of the viewport, for a tall one) that must be visible for it to count as viewed. */
const VIEW_SHARE = 0.5;
/** After an address change, selector Embeds are looked for again after the next frame and after this long (ms). */
const SPA_RETRY_MS = 300;

/** A survey drawn and waiting for its view to be accepted. */
interface Prepared {
  run: Run;
  /** The run's session: an Embed shown again keeps it, so its view is not reported twice. */
  session: string;
  /** Sends `survey_viewed`; true when the server accepted it. Reports wait until then. */
  view(): Promise<boolean>;
}

type Ref = { deref(): Element | undefined };
/** Holds an element without keeping it alive where the browser has WeakRef. */
function weak(el: Element): Ref {
  const W = (globalThis as { WeakRef?: new (el: Element) => Ref }).WeakRef;
  return W ? new W(el) : { deref: () => el };
}

/** One `mount` call. */
interface Embed {
  key: string;
  /** A CSS selector, or the element (held weakly). */
  target: string | Ref;
  /** The element was on the page once: when it leaves, the mount is pruned. */
  seen: boolean;
  run?: Run;
  view?: () => Promise<boolean>;
  session?: string;
  /** The view was accepted: the embed is visible and stays while the identity does. */
  accepted: boolean;
  viewing: boolean;
  /** In the viewport, as far as the observer last said. */
  visible: boolean;
  io?: IntersectionObserver;
}

/** A Tooltip whose triggers hold, waiting for its anchor to be on the page and visible. */
interface Waiting {
  el?: Element;
  visible: boolean;
}

const isElement = (v: unknown): v is Element => !!v && typeof v === "object" && (v as Node).nodeType === 1 && typeof (v as Element).getBoundingClientRect === "function";

/** The element a Tooltip's Design names, when it is on the page. */
function anchorOf(survey: SdkSurvey): Element | null {
  const selector = survey.design.anchor;
  return validSelector(selector) ? document.querySelector(selector) : null;
}

/** Is a modal dialog of the page open? False where the browser does not know `:modal`. */
function hostModal(): boolean {
  try {
    return !!document.querySelector(":modal");
  } catch {
    return false;
  }
}

export function startSurveys(host: SurveyHost): SurveysController {
  let list: SdkSurvey[] = [];
  /** `held`: the `or` groups that held when it was shown by its triggers (for "hide outside"). */
  let open: { survey: SdkSurvey; run: Run; held: Trigger[][] } | undefined;
  const tips = new Map<string, { run: Run; anchor: Element; held: Trigger[][] }>();
  const waitingTips = new Map<string, Waiting>();
  let embeds: Embed[] = [];
  /** A survey was shown in the slot on this address: the next one waits for an address change. */
  let waiting = false;
  /** A show is in progress for the slot (survey_viewed). */
  let pending = false;
  /** Tooltips whose show is in progress. */
  const tipPending = new Set<string>();
  /** Keys asking for a fresh list right now. */
  const asking = new Set<string>();
  let stopped = false;
  /** Bumped on close(): a show that started for an earlier identity is dropped. */
  let epoch = 0;
  const shown = new Set<string>();
  /** View refused or failed, or not drawable: not tried again on this page for this identity (any format). */
  const refused = new Set<string>();
  /** Embeds whose view was accepted on this page for this identity, and whether they were answered. */
  const embedMemo = new Map<string, { session: string; answered: boolean }>();
  const elsewhere = new Set<string>();
  const anonymous = () => !!host.identity() && "anonymous" in host.identity()!;

  const triggers = createTriggerWatch(host.events, () => evaluate(), host.since);

  // The channel is closed while the page is in the back/forward cache: an open one would keep it out.
  let channel: BroadcastChannel | undefined;
  function openChannel() {
    if (channel || stopped) return;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e: MessageEvent) => {
        const key = e.data?.open;
        if (typeof key !== "string") return;
        elsewhere.add(key);
        rewatch();
      };
      (channel as { unref?: () => void }).unref?.();
    } catch {
      channel = undefined; // no BroadcastChannel: each tab decides alone
    }
  }
  function closeChannel() {
    try {
      channel?.close();
    } catch {
      // already closed
    }
    channel = undefined;
  }
  openChannel();
  addEventListener("pagehide", closeChannel);
  addEventListener("pageshow", openChannel);

  /** Surveys that triggers may still show: Popup, Modal, Banner and Tooltip. */
  const candidates = () =>
    list.filter(
      (s) =>
        s.format !== "embed" &&
        s.triggers.length > 0 &&
        !shown.has(s.key) &&
        !refused.has(s.key) &&
        !elsewhere.has(s.key) &&
        (!anonymous() || allowed(s.key, s.showAgain !== false)),
    );

  /** Listeners follow what the surveys that may still show need; the slot's none while one is open. */
  function rewatch() {
    triggers.watch(stopped ? [] : candidates().filter((s) => (competes(s.format) ? !open : !tips.has(s.key))));
  }

  const onVisible = () => {
    if (document.visibilityState === "visible") safe(evaluate)();
  };
  /** Dialogs of the page opening or closing (the `open` attribute). */
  let dialogs: MutationObserver | undefined;
  let visibleOn = false;
  function watchVisibility(on: boolean) {
    if (on === visibleOn) return;
    visibleOn = on;
    document[on ? "addEventListener" : "removeEventListener"]("visibilitychange", onVisible);
    if (on && typeof MutationObserver === "function") {
      dialogs = new MutationObserver(safe(onDialog));
      dialogs.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["open"] });
    } else {
      dialogs?.disconnect();
      dialogs = undefined;
    }
  }

  /** A page dialog opened or closed: the floating surveys hide behind a modal one, and come back after. */
  function onDialog() {
    const modal = hostModal();
    if (open && open.survey.format !== "modal") open.run.hide(modal);
    for (const tip of tips.values()) tip.run.hide(modal);
    if (!modal) evaluate();
  }

  /** The page removed a survey's element (a framework replacing `body` or the target): that run is over. */
  function lost() {
    if (open && !open.run.connected()) {
      const run = open.run;
      open = undefined;
      run.close(false);
    }
    for (const [key, tip] of tips) {
      if (tip.run.connected()) continue;
      tips.delete(key);
      tip.run.close(false);
    }
    for (const embed of embeds) if (embed.run && !embed.run.connected()) drop(embed);
  }

  // ─── Late anchors and late Embed targets ────────────────────────────────

  /**
   * Waiting Tooltips: the anchors that match are observed for visibility
   * (the only place a waiting Tooltip is shown from, so a view is reported
   * only for an anchor someone can see). Missing anchors and unresolved
   * Embed selectors share one throttled page mutation watch, which only
   * looks them up again; it never re-runs the triggers.
   */
  let anchorIo: IntersectionObserver | undefined;
  let lateWatch: MutationObserver | undefined;
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  /** Some selector Embed applies but its element is not on the page. */
  let unresolved = false;

  function observeAnchor(w: Waiting, el: Element | null) {
    if (el === (w.el ?? null)) return;
    if (w.el) anchorIo?.unobserve(w.el);
    w.el = el ?? undefined;
    w.visible = false;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") return void (w.visible = true); // the box check decides
    anchorIo ??= new IntersectionObserver(
      safe((entries: IntersectionObserverEntry[]) => {
        for (const entry of entries) {
          for (const [key, w] of waitingTips) {
            if (w.el !== entry.target) continue;
            w.visible = entry.isIntersecting;
            if (w.visible) tryTip(key);
          }
        }
      }),
    );
    anchorIo.observe(el);
  }

  function unwait(key: string) {
    const w = waitingTips.get(key);
    if (w?.el) anchorIo?.unobserve(w.el);
    waitingTips.delete(key);
  }

  /** A waiting Tooltip whose anchor is visible: shown, unless anything else is in the way. */
  function tryTip(key: string) {
    const w = waitingTips.get(key);
    if (!w?.visible || !anchorVisible(w.el) || tips.has(key) || tipPending.has(key) || asking.has(key) || hostModal()) return;
    attempt(key, true).catch(() => {});
  }

  /** Tick of the mutation watch: look up anchors and Embed targets again, nothing else. */
  function lookAgain() {
    for (const [key, w] of waitingTips) {
      const survey = list.find((s) => s.key === key);
      if (!survey) unwait(key);
      else observeAnchor(w, anchorOf(survey));
    }
    syncEmbeds();
    for (const key of waitingTips.keys()) tryTip(key);
    syncLateWatch();
  }

  function syncLateWatch() {
    const need = !stopped && (unresolved || [...waitingTips.values()].some((w) => !w.el)) && typeof MutationObserver === "function";
    if (need && !lateWatch) {
      lateWatch = new MutationObserver(() => {
        lateTimer ??= setTimeout(() => {
          lateTimer = undefined;
          safe(lookAgain)();
        }, RESCAN_MS);
      });
      lateWatch.observe(document.documentElement, { childList: true, subtree: true });
    } else if (!need && lateWatch) {
      lateWatch.disconnect();
      lateWatch = undefined;
      clearTimeout(lateTimer);
      lateTimer = undefined;
    }
  }

  function evaluate() {
    lost();
    if (stopped || document.visibilityState === "hidden") return;
    const ready = candidates().filter((s) => triggers.satisfied(s));
    if (!open && !waiting && !pending && !hostModal()) {
      const next = ready.find((s) => competes(s.format));
      if (next) attempt(next.key, true).catch(() => {});
    }
    // Tooltips whose triggers hold wait for a visible anchor; the others stop waiting.
    const want = new Set(ready.filter((s) => s.format === "tooltip" && !tips.has(s.key)).map((s) => s.key));
    for (const key of waitingTips.keys()) if (!want.has(key)) unwait(key);
    for (const key of want) {
      let w = waitingTips.get(key);
      if (!w) waitingTips.set(key, (w = { visible: false }));
      observeAnchor(w, anchorOf(list.find((s) => s.key === key)!));
      tryTip(key);
    }
    syncLateWatch();
    for (const embed of embeds) if (embed.visible) viewEmbed(embed);
  }

  /** Asks again when the list is stale, then shows the survey only if the fresh list still has it. */
  async function attempt(key: string, byTrigger: boolean): Promise<boolean> {
    if (stopped || refused.has(key) || asking.has(key)) return false;
    const at = epoch;
    asking.add(key);
    let fresh: SdkSurvey[];
    try {
      fresh = await host.fresh();
    } finally {
      if (at === epoch) asking.delete(key);
    }
    const survey = (Array.isArray(fresh) ? fresh : []).find((s) => s?.key === key);
    if (at !== epoch || stopped || !isRenderable(survey) || elsewhere.has(key) || refused.has(key) || survey.format === "embed") return false;
    // Tooltip or slot is decided on the fresh definition.
    const tip = survey.format === "tooltip";
    if (tip ? tips.has(key) || tipPending.has(key) : open || pending) return false;
    if (byTrigger && (shown.has(key) || !triggers.satisfied(survey) || (!tip && waiting))) return false;
    if (hostModal() || !host.identity()) return false;
    if (tip) tipPending.add(key);
    else pending = true;
    try {
      return await (tip ? showTip(survey, byTrigger, at) : display(survey, byTrigger, at));
    } finally {
      if (at === epoch) {
        if (tip) tipPending.delete(key);
        else pending = false;
      }
    }
  }

  /** Draws the survey invisibly and sets up its reports; `closed` is told when the run ends. */
  function prepare(survey: SdkSurvey, place: Placement, closed: (run: Run) => void, again?: { session: string }): Prepared | undefined {
    const identity = host.identity()!;
    const session = again?.session ?? host.id();
    const submissionId = host.id();
    const reported = new Set<string>();
    // An Embed shown again keeps the session whose view the server already has.
    let accepted = !!again;
    let queue = Promise.resolve();
    const send = (event: SurveyEvent, stepKey?: string) => {
      const body = { identity, versionId: survey.versionId, session, event, ...(stepKey ? { stepKey } : {}) };
      queue = queue.then(() => sendEvent(host.origin, host.key, survey.key, body)).then(() => {}, () => {});
    };
    // Reports wait until the view is accepted and go one after another.
    const report = (event: SurveyEvent, stepKey?: string) => {
      const id = `${event}:${stepKey ?? ""}`;
      if (!accepted || reported.has(id)) return;
      reported.add(id);
      send(event, stepKey);
    };

    const run: Run | undefined = prepareSurvey(
      survey,
      {
        report,
        submit: (answers) =>
          queue.then(() => sendResponse(host.origin, host.key, survey.key, { identity, versionId: survey.versionId, session, submissionId, answers })).then((outcome) => {
            if (outcome === "ok") {
              if (anonymous()) remember(survey.key, "completed");
              const memo = embedMemo.get(survey.key);
              if (memo) memo.answered = true;
            }
            return outcome;
          }),
        closed(dismissed) {
          if (dismissed) {
            report("survey_dismissed");
            if (anonymous()) remember(survey.key, "dismissed");
          }
          if (run) closed(run);
          rewatch();
        },
      },
      host.webFonts,
      place,
    );
    if (!run) return undefined;
    return {
      run,
      session,
      async view() {
        // Nothing is sent for a survey whose styles did not apply.
        if (!(await new Promise<boolean>((resolve) => run!.whenStyled(resolve)))) {
          refused.add(survey.key);
          return false;
        }
        const ok = await sendEvent(host.origin, host.key, survey.key, { identity, versionId: survey.versionId, session, event: "survey_viewed" });
        if (ok) {
          accepted = true;
          reported.add("survey_viewed:");
        } else refused.add(survey.key);
        return ok;
      },
    };
  }

  /** After a survey became visible by its triggers or by `show`: remembered, and the other tabs told. */
  function announce(survey: SdkSurvey) {
    shown.add(survey.key);
    if (anonymous()) remember(survey.key, "shown");
    try {
      channel?.postMessage({ open: survey.key });
    } catch {
      // the other tabs will not know
    }
    rewatch();
  }

  const heldBy = (survey: SdkSurvey, byTrigger: boolean) => (byTrigger ? orGroups(survey.triggers).filter((g) => evaluateTriggers(g, triggers.test)) : []);

  /** Popup, Modal or Banner in the slot. */
  async function display(survey: SdkSurvey, byTrigger: boolean, at: number): Promise<boolean> {
    const prepared = prepare(survey, {}, (run) => {
      if (open?.run === run) open = undefined;
    });
    if (!prepared) {
      refused.add(survey.key);
      return false;
    }
    const { run } = prepared;
    const viewed = await prepared.view();
    if (!viewed || at !== epoch || stopped || open || !run.connected()) {
      run.close(false);
      return false;
    }
    open = { survey, run, held: heldBy(survey, byTrigger) };
    run.reveal();
    if (open?.run !== run) return false; // could not be shown after all
    waiting = true;
    announce(survey);
    if (hostModal() && survey.format !== "modal") run.hide(true);
    return true;
  }

  /** Another Tooltip than `key` is attached to this element. */
  const anchorTaken = (anchor: Element, key: string) => [...tips].some(([k, t]) => k !== key && t.anchor === anchor);

  /** A Tooltip next to its anchor; nothing at all while the anchor is missing or cannot be seen. */
  async function showTip(survey: SdkSurvey, byTrigger: boolean, at: number): Promise<boolean> {
    const key = survey.key;
    const anchor = anchorOf(survey);
    if (!anchorVisible(anchor) || anchorTaken(anchor, key)) return false;
    const prepared = prepare(
      survey,
      {
        anchor,
        reanchor() {
          // The anchor was re-rendered: the new match, when it is visible and free. Nothing is reported.
          const tip = tips.get(key);
          const next = anchorOf(survey);
          if (!tip || !anchorVisible(next) || anchorTaken(next, key)) return null;
          tip.anchor = next;
          return next;
        },
      },
      (run) => {
        if (tips.get(key)?.run === run) tips.delete(key);
      },
    );
    if (!prepared) {
      refused.add(key);
      return false;
    }
    const { run } = prepared;
    const viewed = await prepared.view();
    if (!viewed || at !== epoch || stopped || tips.has(key) || anchorTaken(anchor, key) || !anchorVisible(anchor) || !run.connected()) {
      run.close(false);
      return false;
    }
    tips.set(key, { run, anchor, held: heldBy(survey, byTrigger) });
    unwait(key);
    run.reveal();
    if (tips.get(key)?.run !== run) return false; // the anchor went while it was shown
    announce(survey);
    return true;
  }

  // ─── Embeds ─────────────────────────────────────────────────────────────

  /** Removes an embed's run, leaving its target as it was; the mount stays. */
  function drop(embed: Embed) {
    const run = embed.run;
    embed.io?.disconnect();
    embed.io = embed.run = embed.view = undefined;
    embed.accepted = embed.viewing = embed.visible = false;
    run?.close(false);
  }

  /** The element of a mount right now; null while a selector matches nothing or the element is gone. */
  function targetOf(embed: Embed): Element | null {
    if (typeof embed.target === "string") return validSelector(embed.target) ? document.querySelector(embed.target) : null;
    const el = embed.target.deref();
    return el?.isConnected ? el : null;
  }

  /**
   * Draws every mounted embed the list has and that is not drawn yet; drops
   * those it no longer has, unless already seen. A key whose view was
   * accepted is drawn again visible, without a new view; an answered or
   * refused key stays empty.
   */
  function syncEmbeds() {
    if (stopped || !host.identity()) return;
    unresolved = false;
    const drawn = new Set(embeds.filter((e) => e.run).map((e) => e.key));
    // Mounts of an element that left the page (or was collected) and never drawn: forgotten.
    embeds = embeds.filter((e) => {
      if (e.run || typeof e.target === "string") return true;
      const el = e.target.deref();
      return !!el && (el.isConnected || !e.seen);
    });
    for (const embed of embeds) {
      const survey = list.find((s) => s.key === embed.key && s.format === "embed");
      if (embed.run) {
        if (!survey && !embed.accepted) drop(embed);
        continue;
      }
      const memo = embedMemo.get(embed.key);
      if (!survey || drawn.has(embed.key) || refused.has(embed.key) || memo?.answered || (!memo && anonymous() && !allowed(embed.key, survey.showAgain !== false))) continue;
      const target = targetOf(embed);
      if (!target) {
        if (typeof embed.target === "string") unresolved = true;
        continue;
      }
      embed.seen = true;
      const prepared = prepare(
        survey,
        { target },
        (run) => {
          if (embed.run !== run) return;
          // Ended by itself (a final message): not drawn again for this identity.
          if (!embedMemo.get(embed.key)?.answered) refused.add(embed.key);
          drop(embed);
          syncEmbeds();
        },
        memo,
      );
      if (!prepared) {
        refused.add(embed.key);
        continue;
      }
      embed.run = prepared.run;
      embed.view = prepared.view;
      embed.session = prepared.session;
      drawn.add(embed.key);
      if (memo) {
        // Seen before on this page: shown again as it is, no second view.
        embed.accepted = true;
        const { run } = prepared;
        run.whenStyled((ok) => ok && embed.run === run && run.reveal());
      } else observe(embed);
    }
    syncLateWatch();
  }

  /** `survey_viewed` waits until the embed is in the viewport. */
  function observe(embed: Embed) {
    if (typeof IntersectionObserver !== "function") {
      embed.visible = true;
      return viewEmbed(embed);
    }
    embed.io = new IntersectionObserver(
      safe((entries: IntersectionObserverEntry[]) => {
        for (const entry of entries) {
          if (!entry.target.isConnected) return drop(embed);
          const seen = entry.isIntersecting && (entry.intersectionRatio >= VIEW_SHARE || entry.intersectionRect.height >= window.innerHeight * VIEW_SHARE);
          embed.visible = seen;
          if (seen) viewEmbed(embed);
        }
      }),
      { threshold: [0, VIEW_SHARE, 1] },
    );
    embed.io.observe(embed.run!.el);
  }

  function viewEmbed(embed: Embed) {
    const { run, view, session } = embed;
    if (!run || !view || !session || embed.accepted || embed.viewing || stopped || document.visibilityState === "hidden") return;
    embed.viewing = true;
    const at = epoch;
    view()
      .then((ok) => {
        if (embed.run !== run) return;
        embed.viewing = false;
        if (!ok || at !== epoch || stopped || !run.connected()) return drop(embed); // a refused view is remembered in `refused`
        embedMemo.set(embed.key, { session, answered: false });
        embed.accepted = true;
        embed.io?.disconnect();
        embed.io = undefined;
        run.reveal();
        if (anonymous()) remember(embed.key, "shown");
      })
      .catch(() => safe(drop)(embed));
  }

  function mount(key: string, target: Element | string): () => void {
    if (stopped || typeof key !== "string" || !key || !(typeof target === "string" || isElement(target))) return noop;
    const embed: Embed = { key, target: typeof target === "string" ? target : weak(target), seen: false, accepted: false, viewing: false, visible: false };
    embeds.push(embed);
    syncEmbeds();
    return safe(() => {
      const i = embeds.indexOf(embed);
      if (i < 0) return;
      embeds.splice(i, 1);
      drop(embed);
      syncEmbeds(); // another mount of the same key may take over
    });
  }

  // ─── Entry points ───────────────────────────────────────────────────────

  function update(next: SdkSurvey[]) {
    list = Array.isArray(next) ? next.filter(isRenderable) : [];
    watchVisibility(!stopped && list.length > 0);
    rewatch();
    evaluate();
    syncEmbeds();
  }

  /** "Hide on pages that don't match" is not a dismissal: nothing is reported. */
  function hideOutside() {
    if (open && hiddenOutside(open.held)) {
      const run = open.run;
      open = undefined;
      run.close(false);
    }
    for (const [key, tip] of tips) {
      if (!hiddenOutside(tip.held)) continue;
      tips.delete(key);
      tip.run.close(false);
    }
  }

  /** An app renders the new page after the address changed: selector Embeds are looked for again. */
  let spaFrame = 0;
  let spaTimer: ReturnType<typeof setTimeout> | undefined;
  function clearSpa() {
    if (spaFrame) cancelAnimationFrame(spaFrame);
    clearTimeout(spaTimer);
    spaFrame = 0;
    spaTimer = undefined;
  }
  function address() {
    triggers.address();
    waiting = false;
    lost();
    hideOutside();
    rewatch();
    evaluate();
    syncEmbeds();
    clearSpa();
    if (typeof requestAnimationFrame === "function") spaFrame = requestAnimationFrame(() => ((spaFrame = 0), safe(syncEmbeds)()));
    spaTimer = setTimeout(() => ((spaTimer = undefined), safe(syncEmbeds)()), SPA_RETRY_MS);
  }

  function close() {
    epoch++;
    pending = false;
    tipPending.clear();
    asking.clear();
    const run = open?.run;
    open = undefined;
    // The identity it was shown to is gone: no dismissal is reported for the next one.
    run?.close(false);
    for (const tip of [...tips.values()]) tip.run.close(false);
    tips.clear();
    for (const key of [...waitingTips.keys()]) unwait(key);
    for (const embed of embeds) drop(embed);
    list = [];
    shown.clear();
    refused.clear();
    embedMemo.clear();
    waiting = false;
    unresolved = false;
    clearSpa();
    watchVisibility(false);
    syncLateWatch();
    rewatch();
  }

  /** Every entry point is wrapped: nothing may throw into the host page. */
  function safe<A extends unknown[]>(fn: (...args: A) => void) {
    return (...args: A): void => {
      try {
        fn(...args);
      } catch (error) {
        host.log("surveys:", error);
        try {
          close();
        } catch {
          // nothing more can be done
        }
      }
    };
  }

  const controller: SurveysController = {
    update: safe(update),
    track: safe(evaluate),
    address: safe(address),
    check: safe(evaluate),
    async show(key: string) {
      try {
        lost();
        return typeof key === "string" && (await attempt(key, false));
      } catch {
        return false;
      }
    },
    mount(key: string, target: Element | string) {
      try {
        return mount(key, target);
      } catch (error) {
        host.log("surveys:", error);
        return noop;
      }
    },
    close: safe(close),
    stop: safe(() => {
      close();
      stopped = true;
      embeds = [];
      anchorIo?.disconnect();
      anchorIo = undefined;
      triggers.stop();
      closeChannel();
      removeEventListener("pagehide", closeChannel);
      removeEventListener("pageshow", openChannel);
    }),
  };

  // Mounts the core recorded before this entry loaded; it no longer keeps their targets.
  for (const m of host.mounts ?? []) m[2] = controller.mount(m[0], m[1]);
  host.mounts?.clear();
  return controller;
}

const noop = () => {};
