/**
 * The "page" a survey is laid out on. Live, that is the viewport, and the
 * survey's element goes into `document.body` (an Embed: into its target).
 * A preview (`mountSurveyPreview`) gives a contained stage instead: an
 * element of the tool showing the survey, whose box plays the viewport.
 * The frames read sizes and listen for layout changes only through here.
 */

export interface StageBox {
  top: number;
  left: number;
  width: number;
  height: number;
  /** On-screen pixels per layout pixel (a preview scaled by a transform); 1 when missing. */
  scale?: number;
}

export interface Stage {
  /** A preview: drawn inside `parent`, never in the top layer, never fixed to the viewport, no scroll lock, no focus moves. */
  contained?: boolean;
  /** Where the survey's element goes; `document.body` when missing. */
  parent?: Element;
  /** The page's box in viewport coordinates. */
  box(): StageBox;
  /** The width layout decisions are made on (the Banner's one row). */
  width(): number;
  /** Calls `fn` when the page may have changed size (and, with `scroll`, scrolled); returns the function that stops it. */
  listen(fn: () => void, scroll?: boolean): () => void;
  /** The node whose mutations may move a Tooltip's anchor; none when nothing outside the survey can. */
  watched(): Node | undefined;
  /** Preview only: draws what stands in for the page (a Tooltip's anchor, an Embed's block) into the survey's root. */
  decorate?(root: HTMLElement, format: string): { anchor?: Element; parent?: HTMLElement };
}

const SCROLL = { capture: true, passive: true } as const;

/** The live stage: the window. */
export const viewport: Stage = {
  box: () => ({ top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }),
  width: () => window.innerWidth,
  listen(fn, scroll) {
    if (scroll) addEventListener("scroll", fn, SCROLL);
    addEventListener("resize", fn);
    return () => {
      if (scroll) removeEventListener("scroll", fn, { capture: true });
      removeEventListener("resize", fn);
    };
  },
  watched: () => document.documentElement,
};
