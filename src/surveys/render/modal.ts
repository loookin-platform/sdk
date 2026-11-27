/**
 * Modal: a card in the middle of the window over an optional backdrop. While
 * it is open the page does not scroll (the one change the SDK makes to the
 * host page, restored exactly on close), the focus moves into the card and
 * stays there, and it goes back where it was when the Modal closes. On a
 * narrow screen the card is a sheet at the bottom.
 */
import type { SdkSurvey } from "../types";
import { h } from "./dom";
import { edgeOf, type Frame } from "./popup";

const FOCUSABLE = "button:not(:disabled), input, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * Locks page scrolling on `<html>`. The returned function puts back exactly
 * what was there: the original `style` attribute, character for character,
 * when nothing else changed it meanwhile; otherwise just the `overflow` value.
 */
export function lockScroll(): () => void {
  const html = document.documentElement;
  const original = html.getAttribute("style");
  const value = html.style.getPropertyValue("overflow");
  const priority = html.style.getPropertyPriority("overflow");
  html.style.setProperty("overflow", "hidden", "important");
  const locked = html.getAttribute("style");
  return () => {
    if (html.getAttribute("style") === locked) {
      if (original === null) html.removeAttribute("style");
      else html.setAttribute("style", original);
      // A strict CSP may refuse a style attribute; then the property is put back below.
      if (html.style.getPropertyValue("overflow") === value) return;
    }
    if (value) html.style.setProperty("overflow", value, priority);
    else html.style.removeProperty("overflow");
  };
}

export function modalFrame(survey: SdkSurvey, root: HTMLElement, labelledBy: string): Frame {
  const overlay = h("div", { class: `overlay${survey.design.backdrop === false ? "" : " backdrop"}` });
  const card = h("div", { class: `card modal edge-${edgeOf(survey)}`, role: "dialog", "aria-modal": "true", "aria-labelledby": labelledBy, dir: "auto" });
  overlay.appendChild(card);
  root.appendChild(overlay);

  // Tab and Shift+Tab go round inside the card.
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = (card.getRootNode() as ShadowRoot).activeElement;
    if (e.shiftKey && (active === first || !card.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !card.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  });
  // A click on the backdrop keeps the focus in the card.
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) e.preventDefault();
  });

  let before: HTMLElement | null = null;
  let unlock: (() => void) | undefined;
  return {
    card,
    placed: overlay,
    position: "fixed",
    modal: true,
    activate() {
      before = document.activeElement as HTMLElement | null;
      unlock ??= lockScroll();
    },
    destroy() {
      if (!unlock) return;
      unlock();
      unlock = undefined;
      if (before && before !== document.body && before.isConnected) {
        try {
          before.focus({ preventScroll: true });
        } catch {
          // an element that cannot take focus any more
        }
      }
    },
  };
}
