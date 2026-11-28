/**
 * One survey on screen: its frame (Popup, Modal, Banner, Tooltip or
 * Embed), the walk through the
 * flow, the close button, the "Test" label, sending the response and the
 * thank you. Measuring and sending are the caller's: the runner says what
 * happened through `RunContext`.
 *
 * `prepareSurvey` draws the survey invisibly and checks that its styles
 * applied; `reveal` shows it. Any error, now or in a later interaction,
 * removes everything the survey added and is swallowed. A Modal can always
 * be left with Escape, and a failed send always offers Close, so a survey
 * never traps the page.
 *
 * A preview (`Placement.stage`, see preview.ts) runs the same code on a
 * contained stage; its context keeps the thank you and turns Close into a
 * restart.
 */
import type { SurveyEvent } from "../client";
import type { AnswerInput, SdkSurvey, Step } from "../types";
import { branchesOf, canGoBack, hasValue, progressOf, setAnswer, startWalk, walkAnswers, walkBack, walkEnd, walkNext, walkStep, walkTo } from "../walk";
import { h, icon } from "./dom";
import { bannerFrame } from "./banner";
import { embedFrame } from "./embed";
import { createHostElement } from "./host";
import { modalFrame } from "./modal";
import { popupFrame, type Frame, type FrameEnv } from "./popup";
import { tooltipFrame } from "./tooltip";
import { renderStep, type Guard, type StepView } from "./steps";
import type { Stage } from "./stage";

/** The server's cap for one text answer. */
export const ANSWER_TEXT_MAX = 20_000;
/**
 * All text answers together stay under the 64 kB body limit: a character
 * can take 3 bytes in UTF-8, so the room is shared among the text steps.
 */
const TEXT_BUDGET = 54_000 / 3;
/** The thank you closes itself after this long. */
export const THANKS_MS = 4000;

export interface RunContext {
  report(event: SurveyEvent, stepKey?: string): void;
  /** Sends the response; resolves to `"ok"` or an error code. */
  submit(answers: AnswerInput[]): Promise<string>;
  /** The survey is gone; `dismissed` when the respondent closed it unanswered. */
  closed(dismissed: boolean): void;
  /** Preview: the close button or Escape calls this instead of closing. */
  onClose?(): void;
  /** Preview: a step of the definition is on screen. */
  onStep?(stepKey: string): void;
  /** Preview: the thank you stays instead of closing itself. */
  keepThanks?: boolean;
  /** Preview: the key of the step to start at; the first step when missing or unknown. */
  start?: string;
}

export interface Run {
  /** Shows the prepared survey and reports the first step. */
  reveal(): void;
  /** Removes the survey. `dismiss` counts as closed by the respondent unless answered or sending. */
  close(dismiss: boolean): void;
  /** False once the page removed the survey's element. */
  connected(): boolean;
  /** The survey's element on the page (for an Embed, inside its target). */
  el: Element;
  /** Hides a revealed survey while a modal dialog of the page is open, and shows it again. */
  hide(on: boolean): void;
  /**
   * Calls `cb(true)` once the survey's styles are known to apply (at once,
   * usually), or `cb(false)` after the survey closed because they never did.
   * Nothing may be shown or sent before.
   */
  whenStyled(cb: (ok: boolean) => void): void;
}

/** Where a survey goes: an Embed's target, or a Tooltip's anchor. */
export interface Placement {
  target?: Element;
  anchor?: Element;
  /** Tooltip: the anchor node left the page; the element to follow now, or null. */
  reanchor?(): Element | null;
  /** A contained stage (a preview); the viewport when missing. */
  stage?: Stage;
}

const BASE = { description: "", required: false };
const END_KEY = "__end";
const DEFAULT_THANKS: Step = { ...BASE, key: "__thanks", type: "thanks", title: "Thank you.", description: "Your answer was sent.", button: "" };

/** Codes worth another try; anything else ends the survey with a message. */
const RETRYABLE = ["failed", "rate_limited"];
const FINAL: Record<string, string> = {
  closed: "This survey has just stopped taking answers.",
  already_answered: "You have already answered. Thank you.",
  unavailable: "This survey isn't available any more.",
  stale: "This survey was updated in the meantime.",
  body_too_large: "Your answer is too long to send.",
};
const FINAL_OTHER = "We couldn't save your answer.";
const RETRY = "We couldn't save your answer. Try again.";

let runs = 0;

/** Draws the survey invisibly. `undefined` when it could not be drawn; then nothing is left on the page. */
export function prepareSurvey(survey: SdkSurvey, ctx: RunContext, webFonts: boolean, place: Placement = {}): Run | undefined {
  let host: ReturnType<typeof createHostElement> | undefined;
  let frame: Frame | undefined;
  // The frame talks back to the run, which exists only after the frame.
  const late: FrameEnv = { relayout() {}, lost() {} };
  const env: FrameEnv = { relayout: () => late.relayout(), lost: () => late.lost() };
  try {
    const format = survey.format;
    const stage = place.stage;
    if (!stage && ((format === "embed" && !place.target) || (format === "tooltip" && !place.anchor))) return undefined;
    host = createHostElement(survey, webFonts, format === "embed" ? place.target : undefined, stage);
    // A preview draws its own stand-ins for the page: the Tooltip's anchor, the Embed's block.
    const decor = stage?.decorate?.(host.root, format) ?? {};
    const anchor = decor.anchor ?? place.anchor;
    const label = `loookin-s${runs + 1}-title`;
    frame =
      format === "modal"
        ? modalFrame(survey, host.root, label, !!stage?.contained)
        : format === "banner"
          ? bannerFrame(survey, host.root, label, env, stage)
          : format === "tooltip" && anchor
            ? tooltipFrame(survey, host.root, label, anchor, env, () => place.reanchor?.() ?? null, stage)
            : format === "embed"
              ? embedFrame(survey, decor.parent ?? host.root, label)
              : format === "popup"
                ? popupFrame(survey, host.root, label)
                : undefined;
    if (!frame) throw new Error("no frame for this format");
    const run = build(survey, ctx, host, frame, late);
    // Unstyled (a strict CSP without constructable stylesheets): never show a broken survey. An engine
    // that applies the styles a moment late gets one more look on the next frame; it stays invisible meanwhile.
    const placed = frame;
    const styled = () => getComputedStyle(placed.placed).position === placed.position;
    if (styled()) {
      run.whenStyled = (cb) => cb(true);
      return run;
    }
    if (typeof requestAnimationFrame !== "function") throw new Error("survey styles did not apply");
    let result: boolean | undefined;
    const waiting: ((ok: boolean) => void)[] = [];
    run.whenStyled = (cb) => (result === undefined ? waiting.push(cb) : cb(result));
    requestAnimationFrame(() => {
      try {
        result = run.connected() && styled();
      } catch {
        result = false;
      }
      if (!result) run.close(false);
      for (const cb of waiting) cb(result);
    });
    return run;
  } catch {
    try {
      host?.remove();
      frame?.destroy();
    } catch {
      // nothing more can be done
    }
    return undefined;
  }
}

function build(survey: SdkSurvey, ctx: RunContext, host: ReturnType<typeof createHostElement>, frame: Frame, env: FrameEnv): Run {
  const id = `loookin-s${++runs}`;
  const steps = survey.steps;
  const embed = survey.format === "embed";
  // An Embed is part of the page: it has no close button and keeps its thank you.
  // A Tooltip floats over the page's own controls: it can always be closed.
  const closable = survey.format === "tooltip" || (!embed && survey.design.closeButton !== false);
  const texts = steps.flatMap((s) => [s, ...branchesOf(s).flatMap((b) => b.steps)]).filter((s) => s.type === "text").length;
  const maxLength = Math.min(ANSWER_TEXT_MAX, Math.floor(TEXT_BUDGET / Math.max(1, texts)));

  let walk = startWalk(steps, ctx.start);
  let view: StepView | undefined;
  let revealed = false;
  let finished = false;
  let sending = false;
  /** A send failed and may be tried again: the notice and Close are on the screen. */
  let retry = false;
  let gone = false;
  let thanksTimer: ReturnType<typeof setTimeout> | undefined;
  /** The screen on display, drawn again when the Banner's layout changes. */
  let screen: [Step, { flow: boolean; actions: boolean; onNext(): void }] | undefined;

  function close(dismiss: boolean) {
    if (gone) return;
    gone = true;
    clearTimeout(thanksTimer);
    for (const undo of [() => host.remove(), () => frame.destroy()]) {
      try {
        undo();
      } catch {
        // keep undoing the rest
      }
    }
    ctx.closed(dismiss && revealed && !finished && !sending);
  }

  /** Any error in an interaction closes the survey instead of reaching the page. */
  const guard: Guard = (fn) => (e) => {
    try {
      fn(e);
    } catch {
      close(false);
    }
  };

  const body = h("div");
  let bar: HTMLElement | undefined;
  if (survey.isTest || closable) {
    bar = h("div", { class: "bar" }, survey.isTest && h("span", { class: "test", title: "Test run: nothing is recorded" }, "Test"));
    if (closable) {
      const x = h("button", { type: "button", class: "x", "aria-label": "Close" }, icon("close", 18));
      x.addEventListener("click", guard(() => (ctx.onClose ? ctx.onClose() : close(true))));
      bar.appendChild(x);
    }
  }
  // A Banner reads question, answer, button, then Close: the order on screen.
  if (survey.format === "banner") frame.card.append(body, ...(bar ? [bar] : []));
  else frame.card.append(...(bar ? [bar] : []), body);
  // Non-modal formats say once, politely, that they appeared; the focus stays where it is.
  const live = frame.modal ? undefined : h("div", { class: "sr", role: "status", "aria-live": "polite" });
  if (live) host.root.appendChild(live);

  // Escape always closes a Modal; a Popup when it has a close button.
  frame.card.addEventListener(
    "keydown",
    guard((e: KeyboardEvent) => {
      if (e.key === "Escape" && (frame.modal || closable)) {
        e.stopPropagation();
        if (ctx.onClose) ctx.onClose();
        else close(true);
      }
    }) as EventListener,
  );

  /** Draws a screen; the focus follows into it when it was inside already, or always in a Modal. */
  function show(step: Step, opts: { flow: boolean; actions: boolean; onNext(): void }) {
    if (!host.connected()) return close(false);
    screen = [step, opts];
    const focusInside = !!host.shadow.activeElement;
    const compact = frame.compact?.(step) === true;
    view = renderStep({
      step,
      value: walk.answers[step.key],
      progress: survey.design.progress !== false && opts.flow && !compact ? progressOf(steps, step.key) : undefined,
      canBack: opts.flow && !compact && canGoBack(walk),
      actions: opts.actions,
      compact,
      id,
      maxLength,
      guard,
      onChange(value) {
        ctx.report("survey_started");
        view?.notice(null);
        walk = setAnswer(walk, step.key, value);
      },
      onNext: opts.onNext,
      onBack() {
        walk = walkBack(steps, walk);
        current();
      },
    });
    body.replaceChildren(view.el);
    if (revealed && (focusInside || frame.modal)) view.focus();
    if (step !== DEFAULT_THANKS && step.key !== END_KEY) ctx.onStep?.(step.key);
  }

  function current() {
    const step = walkStep(steps, walk);
    if (!step) return close(false);
    // A preview started at its thank you shows it as after sending.
    if (step.type === "thanks" && ctx.keepThanks) return show(step, { flow: false, actions: false, onNext() {} });
    if (revealed && step.type !== "thanks") ctx.report("survey_step_reached", step.key);
    show(step, { flow: true, actions: true, onNext: next });
  }

  function next() {
    const step = walkStep(steps, walk);
    if (!step || sending) return;
    ctx.report("survey_started");
    if (hasValue(walk.answers[step.key])) ctx.report("survey_step_answered", step.key);
    const end = walkEnd(steps, walk);
    if (end) return void send(end.thanks);
    const to = walkNext(steps, walk);
    if (to !== "done") walk = walkTo(walk, to);
    current();
  }

  async function send(thanks: Step | null) {
    sending = true;
    retry = false;
    view?.busy(true);
    view?.notice(null);
    let outcome: string;
    try {
      outcome = await ctx.submit(walkAnswers(steps, walk));
    } catch {
      outcome = "failed";
    }
    sending = false;
    if (gone) return;
    try {
      view?.busy(false);
      if (outcome === "ok") {
        finished = true;
        show(thanks ?? DEFAULT_THANKS, { flow: false, actions: false, onNext() {} });
        if (!embed && !ctx.keepThanks) thanksTimer = setTimeout(() => close(false), THANKS_MS);
        return;
      }
      if (RETRYABLE.includes(outcome)) {
        // Try again, or leave: also a survey without a close button.
        retry = true;
        offerRetry();
        return;
      }
      finished = true;
      show({ ...BASE, key: END_KEY, type: "message", title: FINAL[outcome] ?? FINAL_OTHER, button: "Close" }, { flow: false, actions: true, onNext: () => close(false) });
    } catch {
      close(false);
    }
  }

  function offerRetry() {
    view?.notice(RETRY);
    view?.offerClose(() => close(false));
  }

  env.lost = () => close(false);
  // The same screen in the other layout, with what it showed (sending, a failed send).
  env.relayout = () => {
    try {
      if (!screen || gone) return;
      show(...screen);
      if (sending) view?.busy(true);
      if (retry) offerRetry();
    } catch {
      close(false);
    }
  };

  current();
  return {
    reveal() {
      if (gone) return;
      try {
        if (!host.connected()) return close(false);
        revealed = true;
        frame.activate();
        host.reveal();
        const step = walkStep(steps, walk);
        if (step && step.type !== "thanks") ctx.report("survey_step_reached", step.key);
        if (live && step) live.textContent = step.title;
        if (frame.modal) view?.focus();
      } catch {
        close(false);
      }
    },
    close,
    connected: () => !gone && host.connected(),
    el: host.el,
    hide(on) {
      if (revealed && !gone) host.hide(on);
    },
    whenStyled: (cb) => cb(true),
  };
}
