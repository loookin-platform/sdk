/**
 * Anonymous mode only: which surveys this device has seen. The server
 * cannot tell anonymous visitors apart, so without this a survey for
 * everyone would come back on every page load. Stored in `localStorage`
 * under `loookin_surveys`, next to the device id the SDK already keeps in
 * anonymous mode; nothing is written outside anonymous mode. `stop()`
 * removes it.
 *
 * State per survey key: shown, dismissed or completed, with the time. A
 * completed or dismissed survey is not shown again by its triggers; a shown
 * one only when the survey says "show again on later visits".
 */
export const MEMORY_KEY = "loookin_surveys";
/** The store keeps the most recent entries only. */
export const MEMORY_MAX = 50;

export type Seen = "shown" | "dismissed" | "completed";
type Store = Record<string, [Seen, number]>;

function read(): Store {
  try {
    const value = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function remember(key: string, state: Seen) {
  const store = read();
  // "completed" and "dismissed" are never downgraded to "shown".
  if (state === "shown" && store[key] && store[key]![0] !== "shown") return;
  store[key] = [state, Date.now()];
  const kept = Object.entries(store)
    .filter(([, v]) => Array.isArray(v) && typeof v[1] === "number")
    .sort((a, b) => b[1][1] - a[1][1])
    .slice(0, MEMORY_MAX);
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // storage is blocked: the memory lasts as long as the page
  }
}

/** May triggers show this survey on this device again? */
export function allowed(key: string, showAgain: boolean): boolean {
  const seen = read()[key]?.[0];
  return !seen || (seen === "shown" && showAgain);
}
