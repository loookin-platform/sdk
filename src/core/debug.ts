import type { Rejection, WireEvent } from "./types";

export type Logger = (...args: unknown[]) => void;

export const silent: Logger = () => {};

/** Console output is opt-in: without `debug` the SDK stays quiet. */
export function createLogger(enabled: unknown): Logger {
  return enabled === true ? (...args) => console.log("[loookin]", ...args) : silent;
}

/** One line per refused event: its name, the server's reason and its advice. */
export function describeRejection(event: WireEvent | undefined, r: Rejection): string {
  let line = `rejected "${event?.event ?? `#${r.index}`}": ${r.reason}`;
  if (r.property) line += ` (${r.property})`;
  if (r.suggestion) line += `, suggestion: ${r.suggestion}`;
  if (r.hint) line += `, hint: ${r.hint}`;
  return line;
}

/** Why sending stopped for good, in words a developer can act on. */
export function describeDisabled(status: number, error: string): string {
  const until = "Sending stops until the page reloads.";
  if (error === "origin_not_allowed") {
    return `This page's origin is not on the key's allowed origins. ${until}`;
  }
  if (error === "quota_exceeded") return `The workspace's event quota is used up. ${until}`;
  return `The server refused the key (${status} ${error}). ${until}`;
}
