/**
 * One step as the respondent sees it: message, rating, choice, text or
 * thank you, with the progress bar, Back and the step's button. Mirrors
 * `components/surveys/step-body.tsx` of the application. Selection state
 * lives in `aria-pressed`, which the stylesheet reads, so an answer
 * updates the step in place instead of drawing it again.
 */
import type { Step, StepAnswer } from "../types";
import { isAnswered, SCALES } from "../walk";
import { face, h, icon } from "./dom";

/** Wraps a listener so that an error in it closes the survey instead of reaching the page. */
export type Guard = <E extends Event>(fn: (e: E) => void) => (e: E) => void;

export interface StepProps {
  step: Step;
  value: StepAnswer;
  /** `[current, total]`; without it (and on thank you) there is no progress bar. */
  progress?: [number, number];
  canBack: boolean;
  /** False hides Back and the button (thank you after sending). */
  actions: boolean;
  /** Unique within the page, for `aria-labelledby`. */
  id: string;
  /** Longest text answer; the counter shows close to it. */
  maxLength: number;
  guard: Guard;
  onChange(value: StepAnswer): void;
  onNext(): void;
  onBack(): void;
}

export interface StepView {
  el: HTMLElement;
  /** Sending: the button cannot be pressed again. */
  busy(on: boolean): void;
  /** A line above the buttons (a refused send), or none. */
  notice(text: string | null): void;
  /** Adds a Close button next to the step's button. */
  offerClose(close: () => void): void;
  /** Focus on the first control (not Back). */
  focus(): void;
}

/** The counter appears when a text is this close to its limit. */
const COUNTER_AT = 0.9;

export function renderStep(props: StepProps): StepView {
  const { step, guard } = props;
  let value = props.value;
  let busy = false;
  const titleId = `${props.id}-title`;
  const asks = step.type !== "message" && step.type !== "thanks";
  const on = <E extends Event>(el: EventTarget, type: string, fn: (e: E) => void) => el.addEventListener(type, guard(fn) as EventListener);

  const next = h("button", { type: "button", class: "next" }, step.button || "Next");
  const ready = () => {
    next.disabled = busy || !isAnswered(step, value);
  };
  const change = (v: StepAnswer) => {
    value = v;
    ready();
    props.onChange(v);
  };
  on(next, "click", () => {
    if (!next.disabled) props.onNext();
  });

  const parts: (Node | false)[] = [];
  if (props.progress && step.type !== "thanks") {
    const [at, total] = props.progress;
    const bar = h("div", { class: "progress", "aria-hidden": "true" });
    for (let i = 0; i < total; i++) bar.appendChild(h("span", { class: i <= at ? "on" : undefined }));
    parts.push(bar);
  }
  if (step.type === "thanks") parts.push(h("span", { class: "done-icon" }, icon("check", 24)));
  parts.push(
    h(
      "div",
      {},
      h("h2", { class: "title", id: titleId }, step.title || "", step.required && asks && h("span", { class: "req", "aria-hidden": "true" }, " *")),
      !!step.description && h("p", { class: "desc" }, step.description),
    ),
  );

  if (step.type === "rating") parts.push(rating(step, value, titleId, change, on));
  if (step.type === "choice") parts.push(choice(step, value, titleId, change, on));
  if (step.type === "text") {
    const attrs = {
      class: "field",
      "aria-labelledby": titleId,
      "aria-required": step.required ? "true" : undefined,
      placeholder: step.placeholder || undefined,
      maxlength: String(props.maxLength),
    };
    const field = step.long ? h("textarea", { ...attrs, rows: "4" }) : h("input", { ...attrs, type: "text" });
    const counter = h("p", { class: "count", "aria-live": "polite", hidden: true });
    const count = () => {
      const n = field.value.length;
      counter.hidden = n < props.maxLength * COUNTER_AT;
      counter.textContent = `${n} / ${props.maxLength}`;
    };
    field.value = typeof value === "string" ? value.slice(0, props.maxLength) : "";
    count();
    on(field, "input", () => {
      count();
      change(field.value);
    });
    if (!step.long) {
      on<KeyboardEvent>(field, "keydown", (e) => {
        // Enter on a short text means Next; not while composing characters (IME).
        if (e.key === "Enter" && !e.isComposing && !next.disabled) {
          e.preventDefault();
          props.onNext();
        }
      });
    }
    parts.push(field, counter);
  }

  const notice = h("p", { class: "notice", role: "alert", hidden: true });
  parts.push(notice);

  const row = h("div", { class: "actions" });
  if (props.actions) {
    const back = props.canBack ? h("button", { type: "button", class: "back", "data-nav": "back" }, "Back") : h("span");
    on(back, "click", () => {
      if (!busy) props.onBack();
    });
    row.append(back, next);
    parts.push(row);
  }
  ready();

  const el = h("div", { class: "step" });
  for (const part of parts) if (part) el.appendChild(part);
  return {
    el,
    busy(state) {
      busy = state;
      ready();
      if (state) next.setAttribute("aria-busy", "true");
      else next.removeAttribute("aria-busy");
    },
    notice(text) {
      notice.textContent = text ?? "";
      notice.hidden = !text;
    },
    offerClose(close) {
      if (row.querySelector("[data-nav='close']")) return;
      const button = h("button", { type: "button", class: "back", "data-nav": "close" }, "Close");
      on(button, "click", close);
      row.insertBefore(button, next);
      if (!row.isConnected) el.appendChild(row);
    },
    focus() {
      el.querySelector<HTMLElement>("input, textarea, button:not([data-nav]):not(:disabled)")?.focus();
    },
  };
}

type On = <E extends Event>(el: EventTarget, type: string, fn: (e: E) => void) => void;

function rating(step: Extract<Step, { type: "rating" }>, value: StepAnswer, labelledBy: string, change: (v: number) => void, on: On): HTMLElement {
  const scale = SCALES[step.scale] ?? SCALES.nps;
  const values = Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i);
  const icons = step.scale === "stars" || step.scale === "emoji";
  const row = h("div", { class: icons ? "icons" : "scale" });
  if (!icons) row.style.setProperty("grid-template-columns", `repeat(${values.length}, minmax(0, 1fr))`);
  const buttons = values.map((v, i) => {
    const button = h("button", { type: "button", "aria-label": String(v) });
    if (icons) {
      if (step.scale === "stars") button.append(icon("starFill", 34, "off", true), icon("starFill", 34, "on"));
      else button.append(face(i, 34, false), face(i, 34, true));
    } else {
      button.textContent = String(v);
    }
    on(button, "click", () => {
      paint(v);
      change(v);
    });
    row.appendChild(button);
    return button;
  });
  // Stars fill up to the chosen value; numbers and faces light the chosen one only.
  const paint = (chosen: number | undefined) =>
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(chosen !== undefined && (step.scale === "stars" ? values[i]! <= chosen : values[i] === chosen))));
  paint(typeof value === "number" ? value : undefined);

  const group = h("div", { role: "group", "aria-labelledby": labelledBy }, row);
  if (step.lowLabel || step.highLabel) group.appendChild(h("div", { class: "ends" }, h("span", {}, step.lowLabel || ""), h("span", {}, step.highLabel || "")));
  return group;
}

function choice(step: Extract<Step, { type: "choice" }>, value: StepAnswer, labelledBy: string, change: (v: string[]) => void, on: On): HTMLElement {
  let picked = Array.isArray(value) ? value : [];
  const group = h("div", { class: "options", role: "group", "aria-labelledby": labelledBy });
  const draws = step.options.map((option) => {
    const button = h("button", { type: "button" });
    const draw = () => {
      const pressed = picked.includes(option.key);
      button.setAttribute("aria-pressed", String(pressed));
      button.replaceChildren(icon(step.multiple ? (pressed ? "boxOn" : "box") : pressed ? "radioOn" : "radio"), option.label);
    };
    on(button, "click", () => {
      // The answer is option keys, also when only one can be picked.
      if (!step.multiple) picked = [option.key];
      else picked = picked.includes(option.key) ? picked.filter((k) => k !== option.key) : [...picked, option.key];
      draws.forEach((d) => d());
      change(picked);
    });
    group.appendChild(button);
    return draw;
  });
  draws.forEach((draw) => draw());
  return group;
}
