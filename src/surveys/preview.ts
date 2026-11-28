/**
 * `mountSurveyPreview`: one survey definition drawn into an element of a
 * tool that displays it (the Loookin editor), with the renderer customers
 * get. The element's box is the page: the live frames run on a contained
 * stage (render/stage.ts) instead of the viewport.
 *
 * Nothing leaves the preview: no requests, no events or responses, no
 * storage, no triggers, no channel to other tabs, no exposure rules and no
 * Test label. The thank you stays; Close (when the format has it) starts
 * again at the first step. Nothing here throws.
 */
import { NARROW_PX } from "./render/banner";
import { h } from "./render/dom";
import { prepareSurvey, type Run } from "./render/runner";
import type { Stage } from "./render/stage";
import { isRenderable, type SdkSurvey } from "./types";
import { positionOf } from "./walk";

export interface SurveyPreviewOptions {
  /** Forces the narrow-screen layout; otherwise it follows the target's width. */
  narrow?: boolean;
  /** Key of the step to show first; the first step by default. */
  step?: string;
  /** False: the survey is drawn but cannot be used. Default true. */
  interactive?: boolean;
  /** Loads the web font the Design asks for, as `surveys: { webFonts: true }` does. Default false. */
  webFonts?: boolean;
  /** Called with the key of the step on screen whenever it changes (also when first drawn). */
  onStep?: (stepKey: string) => void;
}

export interface SurveyPreview {
  /** Draws a new definition or new options, keeping the step on screen when the definition still has it. */
  update(definition: SdkSurvey, options?: SurveyPreviewOptions): void;
  /** Removes the preview and gives the target its children back. */
  destroy(): void;
}

const NOOP: SurveyPreview = { update() {}, destroy() {} };

/** Fields the renderer does not read: a draft without them can still be previewed. */
const FILL = { key: "preview", versionId: "preview", priority: "medium", triggers: [], showAgain: true, language: "" };

/** The preview on each target: a second mount replaces the first. */
const mounted = new WeakMap<Element, SurveyPreview>();

const isElement = (v: unknown): v is Element => !!v && typeof v === "object" && (v as Node).nodeType === 1;

/** The definition to draw, or undefined when it cannot be drawn. */
function drawable(definition: unknown): SdkSurvey | undefined {
  if (!definition || typeof definition !== "object") return undefined;
  const survey = { ...FILL, ...(definition as object), isTest: false };
  return isRenderable(survey) ? survey : undefined;
}

export function mountSurveyPreview(target: Element, definition: SdkSurvey, options?: SurveyPreviewOptions): SurveyPreview {
  try {
    const survey = drawable(definition);
    if (!isElement(target) || !survey || typeof document === "undefined") return NOOP;
    mounted.get(target)?.destroy();
    const handle = mount(target, survey, options ?? {});
    mounted.set(target, handle);
    return handle;
  } catch {
    return NOOP;
  }
}

function mount(target: Element, first: SdkSurvey, initial: SurveyPreviewOptions): SurveyPreview {
  let survey: SdkSurvey | undefined = first;
  let opts = initial;
  let run: Run | undefined;
  let root: HTMLElement | undefined;
  /** The step on screen, as last told to `onStep`. */
  let current: string | undefined;
  let gone = false;
  const listeners = new Set<() => void>();
  let width = contentWidth(target);
  /** Drawn once: a target detached or without size at mount is drawn when it gets one. */
  let started = false;
  const narrow = () => !!opts.narrow || width < NARROW_PX;

  const stage: Stage = {
    contained: true,
    parent: target,
    box() {
      // On-screen pixels per layout pixel: the target may be scaled by a transform (a device frame).
      const el = (root ?? target) as HTMLElement;
      const r = el.getBoundingClientRect();
      const w = el.offsetWidth;
      const scale = r.width > 0 && w > 0 ? r.width / w : 1;
      return { top: r.top, left: r.left, width: w || r.width, height: el.offsetHeight || r.height, scale };
    },
    width: () => (narrow() ? 0 : width),
    listen(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    watched: () => undefined,
    decorate(el, format) {
      root = el;
      el.classList.toggle("narrow", narrow());
      if (opts.interactive === false) el.setAttribute("inert", "");
      if (format === "tooltip") {
        const anchor = h("span", { class: "pv-anchor", "aria-hidden": "true" }, "Anchor");
        el.appendChild(anchor);
        return { anchor };
      }
      if (format === "embed") {
        const parent = h("div", { class: "pv-block" });
        el.appendChild(parent);
        return { parent };
      }
      return {};
    },
  };

  // The target's own children wait outside while a preview is drawn in it, and come back whenever none is.
  const kept = Array.from(target.childNodes);
  const hold = () => kept.forEach((node) => node.parentNode === target && target.removeChild(node));
  const restore = () => target.append(...kept.filter((node) => node.parentNode !== target));

  let resize: ResizeObserver | undefined;
  if (typeof ResizeObserver === "function") {
    resize = new ResizeObserver((entries) => {
      try {
        const entry = entries[entries.length - 1];
        if (!entry || gone) return;
        width = entry.contentRect.width;
        if (!started) return void (target.isConnected && width > 0 && draw(opts.step));
        root?.classList.toggle("narrow", narrow());
        for (const fn of [...listeners]) fn();
      } catch {
        // the next resize tries again
      }
    });
    resize.observe(target);
  }

  function draw(start?: string) {
    const previous = run;
    run = root = undefined;
    previous?.close(false);
    if (!survey || gone) return restore();
    started = true;
    hold();
    const drawn: Run | undefined = prepareSurvey(
      survey,
      {
        report() {},
        submit: () => Promise.resolve("ok"),
        closed() {
          // Closed by an error: nothing is drawn any more.
          if (run && run === drawn) {
            run = root = undefined;
            restore();
          }
        },
        onClose: () => draw(),
        onStep(key) {
          if (key === current) return;
          current = key;
          try {
            opts.onStep?.(key);
          } catch {
            // the tool's callback: its error stays out of the preview
          }
        },
        keepThanks: true,
        start,
      },
      !!opts.webFonts,
      { stage },
    );
    run = drawn;
    if (!drawn) return restore();
    drawn.whenStyled((ok) => {
      if (run !== drawn) return;
      if (!ok) {
        run = root = undefined;
        return restore();
      }
      drawn.reveal();
      // Placed again now that it is visible (a Tooltip measures its anchor inside the preview).
      for (const fn of [...listeners]) fn();
    });
  }

  function destroy() {
    if (gone) return;
    gone = true;
    resize?.disconnect();
    listeners.clear();
    const last = run;
    run = root = undefined;
    last?.close(false);
    restore();
    if (mounted.get(target) === handle) mounted.delete(target);
  }

  // Drawn now when the target is on the page with a width (or nothing can tell when it gets one).
  if (!resize || (target.isConnected && width > 0)) draw(opts.step);
  const handle: SurveyPreview = {
    update(definition, options) {
      if (gone) return;
      try {
        // Options not given stay as they were.
        const next = { ...opts, ...options };
        const jump = next.step !== undefined && next.step !== opts.step;
        opts = next;
        survey = drawable(definition);
        if (!started && resize && !(target.isConnected && width > 0)) return;
        const keep = current !== undefined && survey && positionOf(survey.steps, current) ? current : next.step;
        draw(jump ? next.step : keep);
      } catch {
        destroy();
      }
    },
    destroy() {
      try {
        destroy();
      } catch {
        // nothing more can be done
      }
    },
  };
  return handle;
}

/** The width of the content box in layout pixels, as a ResizeObserver reports it (a transform does not change it). */
function contentWidth(el: Element): number {
  const width = el.clientWidth;
  if (!width) return 0;
  const style = getComputedStyle(el);
  return Math.max(0, width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
}
