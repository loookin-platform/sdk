/**
 * Building DOM without HTML strings: text from a survey definition always
 * goes in as a text node, never as markup. Icons are inline SVG paths drawn
 * with createElementNS, so the renderer also works under Trusted Types.
 */

type Child = Node | string | false | null | undefined;

/** An element with attributes and children; strings become text nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? "" : value);
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * Material Symbols (rounded) glyphs, 24 x 24. Each entry is a list of
 * paths; the hosted page draws the same icons from the icon font.
 */
const PATHS = {
  close: ["M12 13.4 7.1 18.3a1 1 0 0 1-1.4-1.4l4.9-4.9-4.9-4.9a1 1 0 0 1 1.4-1.4l4.9 4.9 4.9-4.9a1 1 0 0 1 1.4 1.4L13.4 12l4.9 4.9a1 1 0 0 1-1.4 1.4z"],
  check: ["m9.55 15.15 8.5-8.5a1 1 0 0 1 1.4 1.4l-9.2 9.2a1 1 0 0 1-1.4 0l-4.3-4.3a1 1 0 0 1 1.4-1.4z"],
  starFill: ["m12 17.27-4.15 2.5a1 1 0 0 1-1.48-1.08l1.1-4.73-3.67-3.17a1 1 0 0 1 .56-1.75l4.85-.42 1.88-4.45a1 1 0 0 1 1.83 0l1.88 4.45 4.85.42a1 1 0 0 1 .56 1.75l-3.67 3.17 1.1 4.73a1 1 0 0 1-1.48 1.08z"],
  radio: ["M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20zm0-2a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"],
  radioOn: ["M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10z", "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20zm0-2a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"],
  box: ["M5 21q-.8 0-1.4-.6T3 19V5q0-.8.6-1.4T5 3h14q.8 0 1.4.6T21 5v14q0 .8-.6 1.4T19 21zm0-2h14V5H5z"],
  boxOn: ["m10.6 13.8-2.15-2.15a1 1 0 0 0-1.4 1.4l2.85 2.85a1 1 0 0 0 1.4 0l5.65-5.65a1 1 0 0 0-1.4-1.4zM5 21q-.8 0-1.4-.6T3 19V5q0-.8.6-1.4T5 3h14q.8 0 1.4.6T21 5v14q0 .8-.6 1.4T19 21z"],
} as const;

/** Faces for the emoji scale, very dissatisfied to very satisfied: mouth path per level. */
const MOUTHS = [
  "M8.2 17.2a4.4 4.4 0 0 1 7.6 0", // very dissatisfied: deep frown
  "M8.8 16.4a3.6 3.6 0 0 1 6.4 0", // dissatisfied
  "M9 15.5h6", // neutral
  "M8.8 14.6a3.6 3.6 0 0 0 6.4 0", // satisfied
  "M8 14a4.6 4.6 0 0 0 8 0z", // very satisfied: open smile
];

function svg(size: number, cls?: string): SVGSVGElement {
  const el = document.createElementNS(SVG, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  return el;
}

function path(parent: SVGElement, d: string, attrs: Record<string, string> = {}) {
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  for (const [name, value] of Object.entries(attrs)) p.setAttribute(name, value);
  parent.appendChild(p);
}

export type IconName = keyof typeof PATHS;

/** An icon; `outlined` draws the shape as a line (the unfilled star). */
export function icon(name: IconName, size = 18, cls?: string, outlined = false): SVGSVGElement {
  const el = svg(size, cls);
  const line = outlined ? { fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linejoin": "round" } : undefined;
  for (const d of PATHS[name]) path(el, d, line);
  return el;
}

/** An emoji face, outlined, or filled when `filled` (the chosen one). */
export function face(level: number, size: number, filled: boolean): SVGSVGElement {
  const el = svg(size, filled ? "on" : "off");
  const line = { fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round" };
  if (filled) {
    path(el, "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z");
    // Features cut out in the card color, as the filled icon does.
    const cut = { fill: "none", stroke: "var(--cp-card-bg)", "stroke-width": "1.8", "stroke-linecap": "round" };
    path(el, "M9 9.6v.8M15 9.6v.8", { ...cut, "stroke-width": "2.4" });
    path(el, MOUTHS[level] ?? MOUTHS[2]!, level === 4 ? { fill: "var(--cp-card-bg)" } : cut);
  } else {
    path(el, "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z", line);
    path(el, "M9 9.6v.8M15 9.6v.8", { ...line, "stroke-width": "2.4" });
    path(el, MOUTHS[level] ?? MOUTHS[2]!, line);
  }
  return el;
}
