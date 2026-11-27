/**
 * The survey's own element on the host page: one element appended to
 * `document.body` with a shadow root. Styles live inside the shadow root;
 * the host page's classes and styles are never touched. The Design becomes
 * `--cp-*` variables on the root. The font is the host page's, unless the
 * page opted into web fonts (`surveys: { webFonts: true }`).
 *
 * Where the browser supports it the element goes into the top layer
 * (`popover="manual"`), so a `transform` or `filter` on the page's body or
 * a competing z-index cannot misplace it; elsewhere it is fixed with the
 * highest z-index. It stays invisible until `reveal()`.
 */
import type { SdkSurvey } from "../types";
import { h } from "./dom";
import { CSS, designVars, fontStack, googleFontHref } from "./styles";

export interface SurveyHostElement {
  /** The element inside the shadow root that everything is drawn into. */
  root: HTMLElement;
  shadow: ShadowRoot;
  /** False once the page removed the element (a framework replacing `body`). */
  connected(): boolean;
  /** Makes the survey visible, in the top layer when the browser has one. */
  reveal(): void;
  /** Removes the element (and a font stylesheet only this survey needed). */
  remove(): void;
}

let sheet: CSSStyleSheet | undefined;

/** Constructed stylesheets are not subject to a page's `style-src`; `<style>` is the fallback. */
function addStyles(shadow: ShadowRoot) {
  try {
    sheet ??= new CSSStyleSheet();
    if (!sheet.cssRules.length) sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    return;
  } catch {
    sheet = undefined;
  }
  shadow.appendChild(h("style", {}, CSS));
}

const fonts = new Map<string, { link: HTMLLinkElement; users: number }>();

/**
 * With `webFonts` only: the web font the Design asks for, loaded the way
 * the hosted survey page loads it, the Google Fonts stylesheet. Font faces
 * declared inside a shadow root are ignored by some browsers, so the
 * stylesheet goes into `document.head`; it only declares the font.
 */
function useFont(font: unknown): (() => void) | undefined {
  const href = googleFontHref(font);
  if (!href) return undefined;
  let entry = fonts.get(href);
  if (!entry) {
    const link = h("link", { rel: "stylesheet", href, "data-loookin-font": "" });
    document.head.appendChild(link);
    entry = { link, users: 0 };
    fonts.set(href, entry);
  }
  entry.users++;
  const used = entry;
  return () => {
    if (--used.users > 0) return;
    used.link.remove();
    fonts.delete(href);
  };
}

/** Inline styles of the element itself: nothing of the page's CSS applies, it takes no room and no clicks. */
const HOST_STYLE: [string, string][] = [
  ["all", "initial"],
  ["position", "fixed"],
  ["top", "0"],
  ["left", "0"],
  ["width", "0"],
  ["height", "0"],
  ["margin", "0"],
  ["padding", "0"],
  ["border", "0"],
  ["overflow", "visible"],
  ["background", "transparent"],
  ["display", "block"],
  ["z-index", "2147483000"],
];

export function createHostElement(survey: SdkSurvey, webFonts: boolean): SurveyHostElement {
  const el = document.createElement("loookin-survey");
  for (const [name, value] of HOST_STYLE) el.style.setProperty(name, value, "important");
  const topLayer = typeof (el as { showPopover?: unknown }).showPopover === "function";
  if (topLayer) el.setAttribute("popover", "manual");
  const shadow = el.attachShadow({ mode: "open" });
  addStyles(shadow);

  const root = h("div", { class: "root", lang: typeof survey.language === "string" && survey.language ? survey.language : undefined });
  for (const [name, value] of Object.entries(designVars(survey.design))) root.style.setProperty(name, value);
  let font = webFonts ? fontStack(survey.design.font) : undefined;
  if (!font) {
    try {
      font = getComputedStyle(document.body).fontFamily;
    } catch {
      // no computed style: the browser's default font
    }
  }
  root.style.setProperty("--cp-font", font || "system-ui, sans-serif");
  root.style.setProperty("visibility", "hidden");
  shadow.appendChild(root);
  const releaseFont = webFonts ? useFont(survey.design.font) : undefined;
  document.body.appendChild(el);

  return {
    root,
    shadow,
    connected: () => el.isConnected,
    reveal() {
      if (topLayer) {
        try {
          (el as unknown as { showPopover(): void }).showPopover();
        } catch {
          // not in the top layer: it is still fixed with the highest z-index
        }
      }
      root.style.removeProperty("visibility");
    },
    remove() {
      el.remove();
      releaseFont?.();
    },
  };
}
