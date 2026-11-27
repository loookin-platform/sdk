/**
 * Popup: a card in one corner of the window, from the Design's `position`
 * (bottom right by default). On a narrow screen it sits at the bottom, full
 * width. A Popup never takes the focus from the host page.
 */
import type { SdkSurvey } from "../types";
import { h } from "./dom";

export interface Frame {
  /** The card: the bar and the step go in here. */
  card: HTMLElement;
  /** The element that must be fixed once the styles applied. */
  placed: HTMLElement;
  /** A Modal moves the focus in, traps it and closes on Escape; a Popup does not take the focus. */
  modal: boolean;
  /** The survey became visible: a Modal locks scrolling and remembers the focus here. */
  activate(): void;
  /** Undoes what `activate` did to the page (scroll lock, focus). */
  destroy(): void;
}

const POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];

export function popupFrame(survey: SdkSurvey, root: HTMLElement, labelledBy: string): Frame {
  const position = POSITIONS.includes(survey.design.position ?? "") ? survey.design.position! : "bottom-right";
  const card = h("div", { class: `card popup ${position} edge-${edgeOf(survey)}`, role: "dialog", "aria-labelledby": labelledBy, dir: "auto" });
  root.appendChild(card);
  return { card, placed: card, modal: false, activate() {}, destroy() {} };
}

export const edgeOf = (survey: SdkSurvey) => (["none", "shadow", "border"].includes(survey.design.edge) ? survey.design.edge : "shadow");
