/**
 * Styles of a survey inside its shadow root, and the Design as CSS
 * variables. The look follows the hosted survey page (components/surveys
 * in the application): same step layout, sizes, spacing and radii. Nothing
 * here reaches the host page: every rule lives in the shadow root.
 */
import type { SurveyDesign } from "../types";

/** Fallbacks when a Design value is missing or not a `#rrggbb` color. */
const DEFAULTS = { accentColor: "#006eff", cardBg: "#ffffff", textColor: "#1a1a1e" };

const HEX = /^#[0-9a-f]{6}$/i;
const color = (value: unknown, fallback: string) => (typeof value === "string" && HEX.test(value) ? value.toLowerCase() : fallback);

/** Mixes two colors: `amount` 0 is `base`, 1 is `over`. */
export function mixHex(base: string, over: string, amount: number): string {
  const ch = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = ch(base);
  const b = ch(over);
  return `#${a.map((c, i) => Math.round(c + (b[i]! - c) * amount).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Fonts of the Design menu: CSS stack and, for web fonts, the Google Fonts
 * family and weights the hosted page loads. `inherit` keeps the host page's font.
 */
const FONTS: Record<string, [stack: string, google?: string, weights?: string]> = {
  inter: ["Inter, sans-serif"],
  "open-sans": ["'Open Sans', sans-serif", "Open+Sans"],
  roboto: ["Roboto, sans-serif", "Roboto"],
  lato: ["Lato, sans-serif", "Lato", "400;700"],
  poppins: ["Poppins, sans-serif", "Poppins"],
  montserrat: ["Montserrat, sans-serif", "Montserrat"],
  nunito: ["Nunito, sans-serif", "Nunito"],
  "dm-sans": ["'DM Sans', sans-serif", "DM+Sans"],
  "source-sans": ["'Source Sans 3', sans-serif", "Source+Sans+3"],
  merriweather: ["Merriweather, serif", "Merriweather"],
  lora: ["Lora, serif", "Lora"],
  playfair: ["'Playfair Display', serif", "Playfair+Display"],
  georgia: ["Georgia, 'Times New Roman', serif"],
};

/** The CSS font stack of the Design; `undefined` keeps the host page's font. */
export function fontStack(font: unknown): string | undefined {
  return typeof font === "string" ? FONTS[font]?.[0] : undefined;
}

/** The Google Fonts stylesheet the hosted page loads for this font; `null` for system fonts and `inherit`. */
export function googleFontHref(font: unknown): string | null {
  const choice = typeof font === "string" ? FONTS[font] : undefined;
  return choice?.[1] ? `https://fonts.googleapis.com/css2?family=${choice[1]}:wght@${choice[2] ?? "400;600"}&display=swap` : null;
}

/** The `--cp-*` variables of the hosted page, from the Design. */
export function designVars(design: Partial<SurveyDesign> | undefined): Record<string, string> {
  const d = design ?? {};
  const card = color(d.cardBg, DEFAULTS.cardBg);
  const text = color(d.textColor, DEFAULTS.textColor);
  const radius = typeof d.borderRadius === "number" && d.borderRadius >= 0 && d.borderRadius <= 24 ? Math.round(d.borderRadius) : 12;
  return {
    "--cp-accent": color(d.accentColor, DEFAULTS.accentColor),
    "--cp-card-bg": card,
    "--cp-text": text,
    "--cp-card-border": mixHex(card, text, 0.1),
    "--cp-input-border": mixHex(card, text, 0.16),
    "--cp-radius": `${radius}px`,
  };
}

/**
 * The stylesheet. The root resets every inherited property, so the host
 * page's text styles do not leak in; the font is the host page's (`--cp-font`,
 * read from the body), or the Design's with `webFonts`. Direction is not
 * forced: the card has `dir="auto"`, so right-to-left text reads right.
 */
const BASE = `
:host{all:initial}
.root{all:initial;display:block;font-family:var(--cp-font);font-size:14px;font-weight:400;font-style:normal;line-height:1.4;letter-spacing:normal;word-spacing:normal;text-transform:none;text-align:start;text-indent:0;text-shadow:none;white-space:normal;color:var(--cp-text);visibility:visible;cursor:auto;-webkit-font-smoothing:antialiased}
.root *,.root *::before,.root *::after{box-sizing:border-box;margin:0;padding:0;border:0;font:inherit;color:inherit;letter-spacing:inherit;text-transform:inherit;background:none}
.root svg{display:block;flex-shrink:0;fill:currentColor}
.root button{cursor:pointer;-webkit-appearance:none;appearance:none;text-align:inherit;line-height:inherit}
.root button:disabled{cursor:default}
.root :focus{outline:none}
.root :focus-visible{outline:2px solid var(--cp-accent);outline-offset:2px}
.card{position:fixed;z-index:2147483000;display:flex;flex-direction:column;background:var(--cp-card-bg);color:var(--cp-text);border-radius:var(--cp-radius);border:1px solid var(--cp-card-border);max-height:calc(100vh - 40px);overflow:auto;overscroll-behavior:contain}
.card.edge-none{border-width:0}
.card.edge-shadow{box-shadow:0 12px 32px rgba(15,15,20,.16),0 2px 6px rgba(15,15,20,.08)}
.popup{width:360px;max-width:calc(100vw - 40px);padding:20px}
.popup.top-left{top:20px;left:20px}.popup.top-right{top:20px;right:20px}
.popup.bottom-left{bottom:20px;left:20px}.popup.bottom-right{bottom:20px;right:20px}
.overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px}
.overlay.backdrop{background:rgba(15,15,20,.45)}
.modal{position:relative;z-index:auto;width:100%;max-width:420px;padding:28px}
.bar{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;margin:-6px -8px 6px 0}
.test{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;color:var(--cp-accent);border:1px solid var(--cp-accent)}
.x{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin-left:auto;border-radius:8px;opacity:.55}
.x:hover{opacity:.9}
.step{display:flex;flex-direction:column;gap:16px}
.progress{display:flex;gap:4px}
.progress span{flex:1;height:4px;border-radius:999px;background:var(--cp-input-border)}
.progress span.on{background:var(--cp-accent)}
.done-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:999px;background:var(--cp-accent);color:#fff}
.title{font-size:17px;font-weight:600;line-height:1.375}
.req{color:var(--cp-accent)}
.desc{margin-top:4px;font-size:13.5px;opacity:.65}
.scale{display:grid;gap:4px}
.scale button{border:1px solid var(--cp-input-border);border-radius:calc(var(--cp-radius) * .5);padding:8px 0;text-align:center;font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}
.scale button[aria-pressed=true]{border-color:var(--cp-accent);background:var(--cp-accent);color:#fff}
.icons{display:flex;gap:6px}
.icons button{padding:2px;color:var(--cp-text);opacity:.35}
.icons button[aria-pressed=true]{color:var(--cp-accent);opacity:1}
.icons .on,.icons button[aria-pressed=true] .off{display:none}
.icons button[aria-pressed=true] .on{display:block}
.ends{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:12px;opacity:.55}
.options{display:flex;flex-direction:column;gap:8px}
.options button{display:flex;align-items:center;gap:8px;border:1px solid var(--cp-input-border);border-radius:calc(var(--cp-radius) * .66);padding:10px 12px;font-size:14px}
.options button[aria-pressed=true]{border-color:var(--cp-accent);box-shadow:inset 0 0 0 1px var(--cp-accent)}
.options svg{opacity:.5}
.options button[aria-pressed=true] svg{color:var(--cp-accent);opacity:1}
.field{display:block;width:100%;border:1px solid var(--cp-input-border);border-radius:calc(var(--cp-radius) * .66);padding:10px 12px;font-size:14px;resize:none;background:transparent}
.field:focus{border-color:var(--cp-accent)}
.field::placeholder{color:var(--cp-text);opacity:.45}
.notice{font-size:13px}
.count{margin-top:-10px;font-size:12px;opacity:.55;text-align:end}
.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:4px}
.back{font-size:13px;opacity:.6}
.next{padding:8px 16px;border-radius:calc(var(--cp-radius) * .66);background:var(--cp-accent);color:#fff;font-size:14px;font-weight:500;transition:opacity .15s}
.next:disabled{opacity:.4}
.banner{left:0;right:0;width:100%;max-height:50vh;padding:12px 20px;border-radius:0;border-width:0}
.banner.top{top:0;border-bottom-width:1px}.banner.bottom{bottom:0;border-top-width:1px}
.banner.edge-none{border-width:0}
.banner.stack{max-height:80vh}
.banner.row{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 16px}
.banner.row>div:not(.bar){flex:1;min-width:0}
.banner .bar{margin:0}
.banner.row .step{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 16px}
.banner.row .step>div:first-child{flex:0 1 auto;min-width:0}
.banner.row .title{font-size:15px}
.banner.row .step>[role=group],.banner.row .field{flex:1 1 auto;min-width:120px}
.banner.row .options{flex-direction:row;flex-wrap:wrap}
.banner.row .options button{padding:6px 10px}
.banner.row .scale button{padding:6px 0}
.banner.row .icons button svg{width:28px;height:28px}
.banner.row .ends,.banner.row .count{display:none}
.banner.row .field{padding:7px 12px}
.banner.row .actions{padding-top:0;flex:0 0 auto}
.banner.row .done-icon{width:32px;height:32px}
.tooltip{width:320px;max-width:calc(100vw - 16px);padding:16px;overflow:visible}
.tooltip>.inner{display:flex;flex-direction:column;max-height:calc(100vh - 40px);overflow:auto;overscroll-behavior:contain}
.arrow{position:absolute;width:12px;height:12px;background:var(--cp-card-bg);transform:rotate(45deg);border:0 solid var(--cp-card-border)}
.tooltip:not(.edge-none) .arrow{border-width:1px}
.tooltip[data-side=bottom] .arrow{top:-7px;border-right-width:0;border-bottom-width:0}
.tooltip[data-side=top] .arrow{bottom:-7px;border-left-width:0;border-top-width:0}
.tooltip[data-side=right] .arrow{left:-7px;border-right-width:0;border-top-width:0}
.tooltip[data-side=left] .arrow{right:-7px;border-left-width:0;border-bottom-width:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.card.embed{position:relative;z-index:auto;width:100%;max-width:100%;max-height:none;overflow:visible;padding:20px}
`;

/** The narrow-screen layout: under 640 px of viewport live, a `narrow` root in a preview. */
const NARROW = `
.popup,.popup.top-left,.popup.top-right,.popup.bottom-left,.popup.bottom-right{top:auto;left:0;right:0;bottom:0;width:100%;max-width:none;border-bottom-left-radius:0;border-bottom-right-radius:0}
.overlay{align-items:flex-end;padding:0}
.modal{max-width:none;padding:20px;border-bottom-left-radius:0;border-bottom-right-radius:0;max-height:90vh}
`;

export const CSS = `${BASE}@media (max-width:640px){${NARROW}}
`;

/**
 * The stylesheet of a preview. The root is the page: a box the size of the
 * preview's element that contains everything (fixed cards are placed in it,
 * not in the viewport), viewport units become units of that box, and the
 * narrow layout follows a `narrow` class instead of the viewport's width.
 * Plus the placeholders that stand in for a Tooltip's anchor and an Embed's block.
 */
export function previewCss(): string {
  const narrow = NARROW.replace(/([^{}]+)\{/g, (_, selectors: string) => `${selectors.trim().split(",").map((s) => `.narrow ${s}`).join(",")}{`);
  return `${BASE}${narrow}`.replace(/(\d+)v([hw])/g, "$1cq$2") +
    ".root{position:absolute;inset:0;overflow:hidden;contain:strict;container-type:size}" +
    ".pv-anchor{position:absolute;top:24px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:8px;border:1px dashed var(--cp-input-border);font-size:13px;opacity:.7}" +
    ".pv-block{position:absolute;inset:0;overflow:auto;padding:20px}";
}
