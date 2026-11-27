/**
 * Embed: a card inside an element the developer chose (`mountSurvey`), in
 * the flow of the page. No close button, no overlay, no triggers, and it
 * never takes the focus. The card takes the target's width; its height is
 * the step's. It is drawn invisibly first, so its room is kept while the
 * view is reported, and becomes visible and interactive only after that.
 */
import type { SdkSurvey } from "../types";
import { h } from "./dom";
import { edgeOf, type Frame } from "./popup";

export function embedFrame(survey: SdkSurvey, root: HTMLElement, labelledBy: string): Frame {
  const card = h("div", { class: `card embed edge-${edgeOf(survey)}`, role: "region", "aria-labelledby": labelledBy, dir: "auto" });
  root.appendChild(card);
  return { card, placed: card, position: "relative", modal: false, activate() {}, destroy() {} };
}
