import { post } from "../core/transport";
import type { AnswerInput, SurveyIdentity } from "./types";

/** No survey request may keep anything waiting for longer than this. */
export const SURVEY_TIMEOUT_MS = 5000;
/** The server refuses bodies over 64 kB; the client stays below with a margin. */
export const MAX_BODY_BYTES = 60_000;

const base = (origin: string, survey: string) => `${origin}/api/sdk/surveys/${encodeURIComponent(survey)}`;

export type SurveyEvent = "survey_viewed" | "survey_started" | "survey_step_reached" | "survey_step_answered" | "survey_dismissed";

export interface EventBody {
  identity: SurveyIdentity;
  versionId: string;
  session: string;
  event: SurveyEvent;
  stepKey?: string;
}

/**
 * Reports one step of a run, with `keepalive` so that a report made while
 * the page goes away still leaves. Resolves to whether the server accepted
 * it (a 2xx answer); never throws, never retries.
 */
export async function sendEvent(origin: string, key: string, survey: string, body: EventBody): Promise<boolean> {
  const answer = await post(`${base(origin, survey)}/events`, key, JSON.stringify(body), true, SURVEY_TIMEOUT_MS);
  return !!answer?.res.ok;
}

export interface ResponseBody {
  identity: SurveyIdentity;
  versionId: string;
  session: string;
  submissionId: string;
  answers: AnswerInput[];
}

/**
 * Sends the response, without `keepalive` (its 64 KiB cap would refuse a
 * long answer). `"ok"`, the server's error code, `"body_too_large"` when the
 * body would be over the limit (not sent), or `"failed"` without a usable answer.
 */
export async function sendResponse(origin: string, key: string, survey: string, body: ResponseBody): Promise<string> {
  const json = JSON.stringify(body);
  if (new TextEncoder().encode(json).length > MAX_BODY_BYTES) return "body_too_large";
  const answer = await post(`${base(origin, survey)}/responses`, key, json, false, SURVEY_TIMEOUT_MS);
  if (answer?.res.ok && answer.json?.data?.ok === true) return "ok";
  const status = answer?.res.status ?? 0;
  // Overloaded or down (whatever the body says): worth another try.
  if (status === 429) return "rate_limited";
  if (status < 400 || status >= 500) return "failed";
  const error = answer?.json?.error;
  return typeof error === "string" ? error : "failed";
}
