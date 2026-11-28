/**
 * Tooltip: a small card next to the element the Design's `anchor` names,
 * on the side with room (below, above, right, left, in that order), with a
 * pointer at the anchor. The card is fixed and kept inside the viewport,
 * also on a narrow screen. The anchor itself is never changed.
 *
 * The position follows the anchor: scrolling (any scroll container),
 * resizing, the anchor or the card changing size, and page mutations
 * schedule one placement per animation frame; a placement reads the
 * anchor's box and the card's size once. While the anchor has no box or is
 * out of the viewport the card hides. When the anchor leaves the page the
 * run closes without a dismissal. Everything is removed on close.
 *
 * Sizes and listeners come from the stage: live the viewport; in a preview
 * the preview's box, with the card placed relative to it.
 */
import type { SdkSurvey } from "../types";
import { h } from "./dom";
import { edgeOf, type Frame, type FrameEnv } from "./popup";
import { viewport, type Stage } from "./stage";

/** Space between the anchor and the card, room for the pointer. */
const GAP = 10;
/** The card keeps this far from the edges of the viewport. */
const MARGIN = 8;
/** The pointer keeps this far from the corners of the card. */
const ARROW_INSET = 14;

export type Side = "bottom" | "top" | "right" | "left";

type Box = { top: number; left: number; bottom: number; right: number; width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Where the card goes: the first side with room for it, else the larger of
 * below and above. Pure, so it is tested without a layout engine.
 */
export function placeTooltip(a: Box, card: { width: number; height: number }, view: { width: number; height: number }): { side: Side; top: number; left: number; arrow: number } {
  const room: Record<Side, boolean> = {
    bottom: view.height - a.bottom >= card.height + GAP + MARGIN,
    top: a.top >= card.height + GAP + MARGIN,
    right: view.width - a.right >= card.width + GAP + MARGIN,
    left: a.left >= card.width + GAP + MARGIN,
  };
  const side = (["bottom", "top", "right", "left"] as const).find((s) => room[s]) ?? (view.height - a.bottom >= a.top ? "bottom" : "top");
  const maxTop = view.height - card.height - MARGIN;
  const maxLeft = view.width - card.width - MARGIN;
  if (side === "bottom" || side === "top") {
    const left = clamp(a.left + a.width / 2 - card.width / 2, MARGIN, maxLeft);
    const top = clamp(side === "bottom" ? a.bottom + GAP : a.top - GAP - card.height, MARGIN, maxTop);
    return { side, top, left, arrow: clamp(a.left + a.width / 2 - left, ARROW_INSET, card.width - ARROW_INSET) };
  }
  const top = clamp(a.top + a.height / 2 - card.height / 2, MARGIN, maxTop);
  const left = clamp(side === "right" ? a.right + GAP : a.left - GAP - card.width, MARGIN, maxLeft);
  return { side, top, left, arrow: clamp(a.top + a.height / 2 - top, ARROW_INSET, card.height - ARROW_INSET) };
}

/** `checkVisibility()` where the browser has it: false for `display: none`, `visibility: hidden` or `opacity: 0` on the way up. */
function rendered(el: Element): boolean {
  const check = (el as { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return typeof check !== "function" || check.call(el, { checkOpacity: true, checkVisibilityCSS: true }) !== false;
}

/**
 * Can someone see the anchor right now? A box, inside the viewport, and
 * rendered. Clipping by the anchor's own scroll container is seen by an
 * IntersectionObserver, which the callers add.
 */
export function anchorVisible(el: Element | null | undefined): el is Element {
  if (!el || !el.isConnected) return false;
  const a = el.getBoundingClientRect();
  return (a.width > 0 || a.height > 0) && a.bottom > 0 && a.right > 0 && a.top < window.innerHeight && a.left < window.innerWidth && rendered(el);
}

/** Frames a replaced anchor may be missing before the Tooltip closes. */
export const ANCHOR_GRACE_FRAMES = 5;

/**
 * `reanchor`: the anchor node left the page; returns the element the
 * selector matches now (visible and not taken by another Tooltip), or null.
 */
export function tooltipFrame(
  survey: SdkSurvey,
  root: HTMLElement,
  labelledBy: string,
  anchor: Element,
  env: FrameEnv,
  reanchor: () => Element | null = () => null,
  stage: Stage = viewport,
): Frame {
  const placed = h("div", { class: `card tooltip edge-${edgeOf(survey)}`, role: "dialog", "aria-labelledby": labelledBy, dir: "auto", "data-side": "bottom" });
  const arrow = h("span", { class: "arrow", "aria-hidden": "true" });
  const card = h("div", { class: "inner" });
  placed.append(arrow, card);
  root.appendChild(placed);

  let frame = 0;
  let active = false;
  let missing = 0;
  /** The anchor's scroll container (or the page) clips it out of view. */
  let clipped = false;
  let resize: ResizeObserver | undefined;
  let mutations: MutationObserver | undefined;
  let clip: IntersectionObserver | undefined;
  let unlisten: (() => void) | undefined;

  const schedule = () => {
    if (active && !frame) frame = requestAnimationFrame(guarded);
  };
  /** Runs from the browser's frame callback: an error closes the run instead of reaching the page. */
  const guarded = () => {
    try {
      place();
    } catch {
      env.lost();
    }
  };

  function follow(next: Element, previous?: Element) {
    if (previous) {
      resize?.unobserve(previous);
      clip?.unobserve(previous);
    }
    anchor = next;
    clipped = false;
    resize?.observe(next);
    clip?.observe(next);
  }

  function place() {
    frame = 0;
    if (!active) return;
    if (!anchor.isConnected) {
      // A framework re-rendered the anchor: follow the new node, or close after a few frames without one.
      const next = reanchor();
      if (!next) {
        if (++missing > ANCHOR_GRACE_FRAMES) return env.lost();
        placed.style.setProperty("visibility", "hidden");
        return schedule();
      }
      follow(next, anchor);
    }
    missing = 0;
    // Every read first, then the writes: one style flush per placement.
    const r = anchor.getBoundingClientRect();
    const size = { width: placed.offsetWidth, height: placed.offsetHeight };
    const s = stage.box();
    const view = { width: s.width, height: s.height };
    // The anchor's box on the stage, in layout pixels (the viewport live, where this changes nothing).
    const k = s.scale || 1;
    const a = { top: (r.top - s.top) / k, left: (r.left - s.left) / k, bottom: (r.bottom - s.top) / k, right: (r.right - s.left) / k, width: r.width / k, height: r.height / k };
    const out = clipped || (!a.width && !a.height) || a.bottom < 0 || a.top > view.height || a.right < 0 || a.left > view.width || !rendered(anchor);
    if (out) return void placed.style.setProperty("visibility", "hidden");
    const at = placeTooltip(a, size, view);
    const along = at.side === "bottom" || at.side === "top" ? "left" : "top";
    placed.style.removeProperty("visibility");
    placed.setAttribute("data-side", at.side);
    placed.style.setProperty("top", `${Math.round(at.top)}px`);
    placed.style.setProperty("left", `${Math.round(at.left)}px`);
    arrow.style.removeProperty(along === "left" ? "top" : "left");
    arrow.style.setProperty(along, `${Math.round(at.arrow - 6)}px`);
  }

  return {
    card,
    placed,
    position: "fixed",
    modal: false,
    activate() {
      if (active) return;
      active = true;
      unlisten = stage.listen(schedule, true);
      if (typeof ResizeObserver === "function") {
        resize = new ResizeObserver(schedule);
        resize.observe(placed);
      }
      if (typeof IntersectionObserver === "function") {
        clip = new IntersectionObserver((entries) => {
          for (const entry of entries) if (entry.target === anchor) clipped = !entry.isIntersecting;
          schedule();
        });
      }
      follow(anchor);
      // Removing the anchor, or content moving it, shows up as a page mutation.
      const watched = stage.watched();
      if (watched && typeof MutationObserver === "function") {
        mutations = new MutationObserver(schedule);
        mutations.observe(watched, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
      }
      place();
    },
    destroy() {
      active = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      unlisten?.();
      unlisten = undefined;
      resize?.disconnect();
      mutations?.disconnect();
      clip?.disconnect();
      resize = mutations = clip = undefined;
    },
  };
}
