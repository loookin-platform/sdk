/**
 * Banner: a bar across the top or bottom edge of the window, from the
 * Design's `position` (bottom by default). On a wide screen the step is
 * drawn in one row: question, control and button, without description,
 * progress bar and Back. Under 640 px the step stacks like in the other
 * formats. A Banner never takes the focus and does not lock scrolling.
 *
 * A step with wide controls (a scale of more than 5 points, more than 4
 * options) is one row only from 1000 px; below that it stacks, so that the
 * controls are never squeezed. The row may also wrap.
 *
 * The width is read from `innerWidth` (no layout read) when a step is drawn
 * and on `resize`, at most once per animation frame; a change of layout
 * draws the current screen again.
 */
import type { SdkSurvey, Step } from "../types";
import { SCALES } from "../walk";
import { h } from "./dom";
import { edgeOf, type Frame, type FrameEnv } from "./popup";

/** Under this width the step stacks. */
export const NARROW_PX = 640;
/** Under this width a step with wide controls stacks. */
export const CROWDED_PX = 1000;

/** A step whose controls need more room than a row leaves next to the question. */
export function crowded(step: Step | undefined): boolean {
  if (step?.type === "choice") return step.options.length > 4;
  if (step?.type !== "rating") return false;
  const scale = SCALES[step.scale] ?? SCALES.nps;
  return scale.max - scale.min + 1 > 5;
}

export function bannerFrame(survey: SdkSurvey, root: HTMLElement, labelledBy: string, env: FrameEnv): Frame {
  const position = survey.design.position === "top" ? "top" : "bottom";
  const card = h("div", { class: `card banner ${position} edge-${edgeOf(survey)}`, role: "dialog", "aria-labelledby": labelledBy, dir: "auto" });
  root.appendChild(card);

  let step: Step | undefined;
  const oneRow = () => window.innerWidth >= (crowded(step) ? CROWDED_PX : NARROW_PX);
  let row = false;
  const mark = () => {
    row = oneRow();
    card.classList.toggle("row", row);
    card.classList.toggle("stack", !row);
  };
  mark();

  let frame = 0;
  let listening = false;
  const measure = () => {
    frame = 0;
    if (oneRow() !== row) env.relayout(); // draws the step again through compact(); guarded by the run
  };
  const onResize = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };

  return {
    card,
    placed: card,
    position: "fixed",
    modal: false,
    compact(next) {
      step = next;
      mark();
      return row;
    },
    activate() {
      if (listening) return;
      listening = true;
      addEventListener("resize", onResize);
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (listening) removeEventListener("resize", onResize);
      listening = false;
    },
  };
}
