/**
 * The surveys entry (`@loookin/sdk/surveys`). The core entry loads it with a
 * dynamic import when the workspace returned at least one survey, and talks
 * to it through `startSurveys`. This entry decides what it can show:
 * formats, schema and the shape of every definition.
 *
 * At most one Popup or Modal is on screen. Surveys are tried in the order
 * the server returned them (already sorted by priority); after one was
 * shown, the next waits for the next address change. A survey shown on this
 * page is not shown again by its triggers until the page reloads (in
 * anonymous mode not on later visits either, see memory.ts). Two tabs do
 * not show the same survey: a `BroadcastChannel` tells the others.
 *
 * A survey is drawn invisibly first, then `survey_viewed` is sent, and only
 * when the server accepted it does the survey become visible: an exposure
 * the server did not record would drop the rest of the run.
 */
import { sendEvent, sendResponse, type SurveyEvent } from "./client";
import { allowed, remember } from "./memory";
import { prepareSurvey, type Run } from "./render/runner";
import { createTriggerWatch, evaluateTriggers, hiddenOutside, orGroups } from "./triggers";
import { isRenderable, type SdkSurvey, type SurveyHost, type SurveysController, type Trigger } from "./types";

export type { SdkSurvey, SurveyHost, SurveysController } from "./types";

const CHANNEL = "loookin-surveys";

export function startSurveys(host: SurveyHost): SurveysController {
  let list: SdkSurvey[] = [];
  /** `held`: the `or` groups that held when it was shown by its triggers (for "hide outside"). */
  let open: { survey: SdkSurvey; run: Run; held: Trigger[][] } | undefined;
  /** A survey was shown on this address: the next one waits for an address change. */
  let waiting = false;
  /** A show is in progress (fresh list, survey_viewed). */
  let pending = false;
  let stopped = false;
  /** Bumped on close(): a show that started for an earlier identity is dropped. */
  let epoch = 0;
  const shown = new Set<string>();
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

  const candidates = () =>
    list.filter((s) => s.triggers.length > 0 && !shown.has(s.key) && !elsewhere.has(s.key) && (!anonymous() || allowed(s.key, s.showAgain !== false)));

  /** Listeners follow what the surveys that may still show need; none while one is open. */
  function rewatch() {
    triggers.watch(open || stopped ? [] : candidates());
  }

  const onVisible = () => {
    if (document.visibilityState === "visible") safe(evaluate)();
  };
  let visibleOn = false;
  function watchVisibility(on: boolean) {
    if (on === visibleOn) return;
    visibleOn = on;
    document[on ? "addEventListener" : "removeEventListener"]("visibilitychange", onVisible);
  }

  /** The page removed the survey's element (a framework replacing `body`): the run is over. */
  function lost() {
    if (open && !open.run.connected()) {
      const run = open.run;
      open = undefined;
      run.close(false);
    }
  }

  function evaluate() {
    lost();
    if (stopped || open || waiting || pending || document.visibilityState === "hidden") return;
    const ready = candidates().find((s) => triggers.satisfied(s));
    if (ready) attempt(ready.key, true).catch(() => {});
  }

  /** Asks again when the list is stale, then shows the survey only if the fresh list still has it. */
  async function attempt(key: string, byTrigger: boolean): Promise<boolean> {
    if (stopped || open || pending) return false;
    pending = true;
    const at = epoch;
    try {
      const fresh = await host.fresh();
      const survey = (Array.isArray(fresh) ? fresh : []).find((s) => s?.key === key);
      if (at !== epoch || stopped || open || !isRenderable(survey) || elsewhere.has(key)) return false;
      if (byTrigger && (waiting || shown.has(key) || !triggers.satisfied(survey))) return false;
      return await display(survey, byTrigger, at);
    } finally {
      if (at === epoch) pending = false;
    }
  }

  async function display(survey: SdkSurvey, byTrigger: boolean, at: number): Promise<boolean> {
    const identity = host.identity();
    if (!identity) return false;
    const session = host.id();
    const submissionId = host.id();
    const reported = new Set<string>();
    let accepted = false;
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

    const run = prepareSurvey(
      survey,
      {
        report,
        submit: (answers) =>
          queue.then(() => sendResponse(host.origin, host.key, survey.key, { identity, versionId: survey.versionId, session, submissionId, answers })).then((outcome) => {
            if (outcome === "ok" && anonymous()) remember(survey.key, "completed");
            return outcome;
          }),
        closed(dismissed) {
          if (dismissed) {
            report("survey_dismissed");
            if (anonymous()) remember(survey.key, "dismissed");
          }
          if (open?.run === run) open = undefined;
          rewatch();
        },
      },
      host.webFonts,
    );
    if (!run) return false;

    const viewed = await sendEvent(host.origin, host.key, survey.key, { identity, versionId: survey.versionId, session, event: "survey_viewed" });
    if (!viewed || at !== epoch || stopped || open || !run.connected()) {
      run.close(false);
      return false;
    }
    accepted = true;
    reported.add("survey_viewed:");
    const held = byTrigger ? orGroups(survey.triggers).filter((g) => evaluateTriggers(g, triggers.test)) : [];
    open = { survey, run, held };
    run.reveal();
    if (open?.run !== run) return false; // could not be shown after all
    shown.add(survey.key);
    waiting = true;
    if (anonymous()) remember(survey.key, "shown");
    try {
      channel?.postMessage({ open: survey.key });
    } catch {
      // the other tabs will not know
    }
    rewatch();
    return true;
  }

  function update(next: SdkSurvey[]) {
    list = Array.isArray(next) ? next.filter(isRenderable) : [];
    watchVisibility(!stopped && list.length > 0);
    rewatch();
    evaluate();
  }

  function address() {
    triggers.address();
    waiting = false;
    lost();
    // "Hide on pages that don't match" is not a dismissal: nothing is reported.
    if (open && hiddenOutside(open.held)) {
      const run = open.run;
      open = undefined;
      run.close(false);
    }
    rewatch();
    evaluate();
  }

  function close() {
    epoch++;
    pending = false;
    const run = open?.run;
    open = undefined;
    // The identity it was shown to is gone: no dismissal is reported for the next one.
    run?.close(false);
    list = [];
    shown.clear();
    waiting = false;
    watchVisibility(false);
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

  return {
    update: safe(update),
    track: safe(evaluate),
    address: safe(address),
    check: safe(evaluate),
    async show(key: string) {
      try {
        lost();
        return typeof key === "string" && !open && (await attempt(key, false));
      } catch {
        return false;
      }
    },
    close: safe(close),
    stop: safe(() => {
      close();
      stopped = true;
      triggers.stop();
      closeChannel();
      removeEventListener("pagehide", closeChannel);
      removeEventListener("pageshow", openChannel);
    }),
  };
}
