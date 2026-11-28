/**
 * A respondent's walk through a flow: a port of the application's
 * `lib/surveys/walk.ts` and the walking part of `lib/surveys/flow.ts`. Same
 * behaviour, proven against fixtures generated from the application code
 * (tests/fixtures/flows). Keep the two in step.
 *
 * The flow is a main line of steps. A rating step can split by score, a
 * choice step by option; a branch has its own steps and then the walk goes
 * on with the next main step, unless the branch ends with its own thank you.
 */
import type { AnswerInput, Branch, OptionBranch, RatingScale, Step, StepAnswer } from "./types";

export const SCALES: Record<RatingScale, { min: number; max: number }> = {
  nps: { min: 0, max: 10 },
  ten: { min: 1, max: 10 },
  stars: { min: 1, max: 5 },
  emoji: { min: 1, max: 5 },
};

/** Index on the main line, and the index inside a branch of that step. */
export type FlowPosition = { main: number; branch?: { key: string; index: number } };

/** Positions walked (the last one is current) and the answers on the way. */
export type Walk = { history: FlowPosition[]; answers: Record<string, StepAnswer> };

export function branchesOf(step: Step | undefined): Branch[] {
  return step && (step.type === "rating" || step.type === "choice") && Array.isArray(step.branches) ? step.branches : [];
}

const isOptionBranch = (branch: Branch): branch is OptionBranch => "optionKeys" in branch;

export function stepAt(steps: Step[], position: FlowPosition): Step | undefined {
  const step = steps[position.main];
  if (!step || !position.branch) return step;
  const { key, index } = position.branch;
  return branchesOf(step).find((b) => b.key === key)?.steps[index];
}

/** Does the answer fall into the branch? Scores by range, options by key (one picked is enough). */
export function branchMatches(branch: Branch, answer: StepAnswer): boolean {
  if (isOptionBranch(branch)) {
    const picked = Array.isArray(answer) ? answer : typeof answer === "string" ? [answer] : [];
    return picked.some((key) => branch.optionKeys.includes(key));
  }
  return typeof answer === "number" && answer >= branch.min && answer <= branch.max;
}

/** Where Next leads from `position` given its answer; `"done"` when the flow ends. */
export function nextStep(steps: Step[], position: FlowPosition, answer?: StepAnswer): FlowPosition | "done" {
  const current = stepAt(steps, position);
  if (!current || current.type === "thanks") return "done";
  if (position.branch) {
    const branch = branchesOf(steps[position.main]).find((b) => b.key === position.branch!.key);
    const index = position.branch.index + 1;
    if (branch && index < branch.steps.length) return { main: position.main, branch: { key: branch.key, index } };
  } else {
    const branch = branchesOf(current).find((b) => branchMatches(b, answer));
    if (branch && branch.steps.length > 0) return { main: position.main, branch: { key: branch.key, index: 0 } };
  }
  return position.main + 1 < steps.length ? { main: position.main + 1 } : "done";
}

/**
 * Progress as `[segment index from zero, segment count]`. Branch steps
 * count, the longest branch of a splitting step; thank you does not count
 * and ends its line.
 */
export function progressOf(steps: Step[], stepKey: string): [number, number] {
  const asked = (row: Step[]) => {
    const end = row.findIndex((s) => s.type === "thanks");
    return end < 0 ? row : row.slice(0, end);
  };
  let total = 0;
  let at = 0;
  for (const step of asked(steps)) {
    if (step.key === stepKey) at = total;
    let longest = 0;
    for (const branch of branchesOf(step)) {
      const inner = asked(branch.steps);
      const index = inner.findIndex((s) => s.key === stepKey);
      if (index >= 0) at = total + 1 + index;
      longest = Math.max(longest, inner.length);
    }
    total += 1 + longest;
  }
  return [at, total];
}

/** Where the step with this key is, on the main line or in a branch; undefined when no step has it. */
export function positionOf(steps: Step[], key: string): FlowPosition | undefined {
  for (let main = 0; main < steps.length; main++) {
    if (steps[main]!.key === key) return { main };
    for (const branch of branchesOf(steps[main])) {
      const index = branch.steps.findIndex((s) => s.key === key);
      if (index >= 0) return { main, branch: { key: branch.key, index } };
    }
  }
  return undefined;
}

/** A walk from the first step, or (a preview) from the step with the key `at`. */
export const startWalk = (steps: Step[] = [], at?: string): Walk => ({ history: [(at !== undefined && positionOf(steps, at)) || { main: 0 }], answers: {} });

export const walkPosition = (walk: Walk): FlowPosition => walk.history[walk.history.length - 1]!;

export const walkStep = (steps: Step[], walk: Walk): Step | undefined => stepAt(steps, walkPosition(walk));

export const canGoBack = (walk: Walk): boolean => walk.history.length > 1;

export const setAnswer = (walk: Walk, stepKey: string, value: StepAnswer): Walk => ({ ...walk, answers: { ...walk.answers, [stepKey]: value } });

export function walkNext(steps: Step[], walk: Walk): FlowPosition | "done" {
  const current = walkStep(steps, walk);
  return nextStep(steps, walkPosition(walk), current ? walk.answers[current.key] : undefined);
}

export const walkTo = (walk: Walk, position: FlowPosition): Walk => ({ ...walk, history: [...walk.history, position] });

/** One step back. The answer of the step being left is dropped: another branch may follow. */
export function walkBack(steps: Step[], walk: Walk): Walk {
  if (!canGoBack(walk)) return walk;
  const leaving = walkStep(steps, walk);
  const answers = leaving ? Object.fromEntries(Object.entries(walk.answers).filter(([key]) => key !== leaving.key)) : walk.answers;
  return { history: walk.history.slice(0, -1), answers };
}

/** Does Next from the current step end the walk? `thanks` is the step to show after sending. */
export function walkEnd(steps: Step[], walk: Walk): { thanks: Step | null } | null {
  const to = walkNext(steps, walk);
  if (to === "done") return { thanks: null };
  const step = stepAt(steps, to);
  return step?.type === "thanks" ? { thanks: step } : null;
}

/** An answer worth sending: not an empty text or an empty selection. */
export function hasValue(value: StepAnswer): boolean {
  if (typeof value === "number") return true;
  if (typeof value === "string") return value.trim() !== "";
  return Array.isArray(value) && value.length > 0;
}

/** May the respondent go on? Optional steps and steps without an answer always. */
export function isAnswered(step: Step, value: StepAnswer): boolean {
  if (!step.required || step.type === "message" || step.type === "thanks") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined;
}

/** Answers on the walked path, in the order walked, shaped for the responses endpoint. */
export function walkAnswers(steps: Step[], walk: Walk): AnswerInput[] {
  const out: AnswerInput[] = [];
  const seen = new Set<string>();
  for (const position of walk.history) {
    const step = stepAt(steps, position);
    if (!step || seen.has(step.key)) continue;
    seen.add(step.key);
    const value = walk.answers[step.key];
    if (!hasValue(value)) continue;
    if (typeof value === "number") out.push({ stepKey: step.key, score: value });
    else if (typeof value === "string") out.push({ stepKey: step.key, text: value.trim() });
    else if (Array.isArray(value)) out.push({ stepKey: step.key, optionKeys: value });
  }
  return out;
}
