/**
 * Popup: a card in one corner of the window, from the Design's `position`
 * (bottom right by default). On a narrow screen it sits at the bottom, full
 * width. A Popup never takes the focus from the host page.
 */
import type { SdkSurvey, Step } from "../types";
import { h } from "./dom";

export interface Frame {
  /** The card: the bar and the step go in here. */
  card: HTMLElement;
  /** The element whose computed `position` shows that the styles applied. */
  placed: HTMLElement;
  /** That position: `fixed` on top of the page, `relative` for an Embed in the page. */
  position: "fixed" | "relative";
  /** A Modal moves the focus in, traps it and closes on Escape; a Popup does not take the focus. */
  modal: boolean;
  /** The survey became visible: a Modal locks scrolling and remembers the focus here. */
  activate(): void;
  /** Undoes what `activate` did to the page (scroll lock, focus) and removes its listeners. */
  destroy(): void;
  /** Banner: is this step drawn in one row (no description, progress and Back)? Also sets the layout. */
  compact?(step: Step): boolean;
}

/** What a frame may tell the run. */
export interface FrameEnv {
  /** The layout changed (Banner crossed the narrow width): draw the current screen again. */
  relayout(): void;
  /** The element the frame depends on is gone (Tooltip anchor): close without a dismissal. */
  lost(): void;
}

const POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];

export function popupFrame(survey: SdkSurvey, root: HTMLElement, labelledBy: string): Frame {
  const position = POSITIONS.includes(survey.design.position ?? "") ? survey.design.position! : "bottom-right";
  const card = h("div", { class: `card popup ${position} edge-${edgeOf(survey)}`, role: "dialog", "aria-labelledby": labelledBy, dir: "auto" });
  root.appendChild(card);
  return { card, placed: card, position: "fixed", modal: false, activate() {}, destroy() {} };
}

export const edgeOf = (survey: SdkSurvey) => (["none", "shadow", "border"].includes(survey.design.edge) ? survey.design.edge : "shadow");
