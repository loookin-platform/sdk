import type { Properties } from "./core/types";

export interface AutoTrackOptions {
  /** Send `page_viewed` on load and on every in-app navigation. */
  pageViews?: boolean;
  /** Send `campaign_arrived` once when the page is opened with UTM parameters. */
  campaigns?: boolean;
}

const UTM = ["utm_source", "utm_medium", "utm_campaign"] as const;

/**
 * Starts the automatic events that were asked for. Call once per page load.
 * `track` must never throw.
 */
export function startAutoTrack(options: AutoTrackOptions, track: (event: string, properties: Properties) => void) {
  if (options.campaigns === true) {
    const query = new URLSearchParams(location.search);
    const properties: Properties = {};
    for (const name of UTM) {
      const value = query.get(name);
      if (value) properties[name] = value;
    }
    if (Object.keys(properties).length) track("campaign_arrived", { ...properties, landing_page: location.pathname });
  }

  if (options.pageViews !== true) return;

  // One event per path change, however many history calls a router makes.
  let last: string | undefined;
  const pageViewed = () => {
    const page = location.pathname;
    if (page === last) return;
    last = page;
    track("page_viewed", document.referrer ? { page, referrer: document.referrer } : { page });
  };

  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      // If the original throws, the caller sees it exactly as before.
      const result = original.apply(this, args);
      try {
        pageViewed();
      } catch {
        // never break navigation
      }
      return result;
    };
  }
  window.addEventListener("popstate", pageViewed);
  pageViewed();
}
