/**
 * In-app navigation, shared by auto-tracking and surveys. A navigation is
 * `pushState`, `popstate`, `hashchange`, or any history call that changes
 * the path. A `replaceState` that changes only the query or the hash (a
 * search box syncing to the address) is not one.
 *
 * The history methods are wrapped on the first subscriber and stay wrapped
 * (unwrapping could undo someone else's wrapper); with no subscriber left the
 * wrapper does nothing and the window listeners are removed.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let wrapped = false;
let path = "";
let at = Date.now();

/** When the page loaded or last navigated (ms). */
export const navigatedAt = () => at;

function changed(navigation: boolean) {
  if (!listeners.size || (!navigation && location.pathname === path)) return;
  path = location.pathname;
  at = Date.now();
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a listener never breaks navigation
    }
  }
}

const onEvent = () => changed(true);

/** Calls `fn` on every navigation; returns the unsubscribe function. */
export function onNavigation(fn: Listener): () => void {
  if (!wrapped) {
    wrapped = true;
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        // If the original throws, the caller sees it exactly as before.
        const result = original.apply(this, args);
        changed(method === "pushState");
        return result;
      };
    }
  }
  if (!listeners.size) {
    path = location.pathname;
    addEventListener("popstate", onEvent);
    addEventListener("hashchange", onEvent);
  }
  listeners.add(fn);
  return () => {
    if (listeners.delete(fn) && !listeners.size) {
      removeEventListener("popstate", onEvent);
      removeEventListener("hashchange", onEvent);
    }
  };
}
