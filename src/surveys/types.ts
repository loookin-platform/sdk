/**
 * Survey definitions as the workspace sends them (`POST /api/sdk/surveys`),
 * and the small interface between the core entry and the lazily loaded
 * surveys entry. Shapes follow the server; the SDK reads them defensively.
 */

/** The definition schema this SDK version understands. Higher ones are skipped. */
export const SURVEY_SCHEMA = 1;

export type RatingScale = "nps" | "ten" | "stars" | "emoji";

export interface ChoiceOption {
  key: string;
  label: string;
}

interface BranchBase {
  key: string;
  label: string;
  steps: Step[];
}
export type ScoreBranch = BranchBase & { min: number; max: number };
export type OptionBranch = BranchBase & { optionKeys: string[] };
export type Branch = ScoreBranch | OptionBranch;

interface StepBase {
  key: string;
  title: string;
  description: string;
  button: string;
  required: boolean;
}
export type MessageStep = StepBase & { type: "message" };
export type ThanksStep = StepBase & { type: "thanks" };
export type RatingStep = StepBase & { type: "rating"; scale: RatingScale; lowLabel: string; highLabel: string; branches?: ScoreBranch[] };
export type ChoiceStep = StepBase & { type: "choice"; options: ChoiceOption[]; multiple: boolean; branches?: OptionBranch[] };
export type TextStep = StepBase & { type: "text"; long: boolean; placeholder: string };
export type Step = MessageStep | RatingStep | ChoiceStep | TextStep | ThanksStep;

/** Score (rating), option keys (choice), text, or nothing. */
export type StepAnswer = number | string | string[] | undefined;

/** One answer as the responses endpoint expects it. */
export interface AnswerInput {
  stepKey: string;
  score?: number;
  text?: string;
  optionKeys?: string[];
}

export type PageRule = { op: "contains" | "equals" | "starts_with"; value: string };
export type TriggerJoin = "and" | "or";
export type Trigger =
  | { kind: "page_load"; join: TriggerJoin; pages: "any" | PageRule[]; hideOutside: boolean }
  | { kind: "event"; join: TriggerJoin; event: string }
  | { kind: "element_view" | "click"; join: TriggerJoin; selector: string }
  | { kind: "time_on_page"; join: TriggerJoin; seconds: number }
  | { kind: "exit_intent"; join: TriggerJoin };

export type PopupPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface SurveyDesign {
  accentColor: string;
  pageBg: string;
  cardBg: string;
  textColor: string;
  borderRadius: number;
  font: string;
  edge: "none" | "shadow" | "border";
  progress: boolean;
  closeButton?: boolean;
  backdrop?: boolean;
  position?: string;
  anchor?: string;
}

export interface SdkSurvey {
  key: string;
  versionId: string;
  format: string;
  schema: number;
  priority: string;
  isTest: boolean;
  design: SurveyDesign;
  steps: Step[];
  triggers: Trigger[];
  showAgain: boolean;
  language: string;
}

/** Who the survey requests are for: an identified user, or anonymous mode. */
export type SurveyIdentity = { user?: string; company?: string } | { anonymous: true };

/** What the core entry gives the surveys entry. */
export interface SurveyHost {
  /** Workspace origin, for example "https://acme.loookin.com". */
  origin: string;
  /** Publishable key. */
  key: string;
  /** The identity right now; undefined when there is none. */
  identity(): SurveyIdentity | undefined;
  /** The current list, asked again first when it is older than its ttl. Never rejects. */
  fresh(): Promise<SdkSurvey[]>;
  /** Names of events passed to `track` for the current identity. */
  events: ReadonlySet<string>;
  /** A random id (UUID v4). */
  id(): string;
  log(...args: unknown[]): void;
  /** When the page loaded or last navigated (ms): time on page counts from here. */
  since(): number;
  /** `surveys: { webFonts: true }`: load the web font a Design asks for. */
  webFonts: boolean;
  /** `mountSurvey` calls made before this entry loaded: key, target, and the remove function this entry sets. */
  mounts?: Set<[string, Element | string, (() => void)?]>;
}

/** What the surveys entry gives back to the core entry. Nothing here throws. */
export interface SurveysController {
  /** A new list arrived. */
  update(surveys: SdkSurvey[]): void;
  /** `track(event)` was called. */
  track(event: string): void;
  /** The address changed without a page load. */
  address(): void;
  /** Something may have changed (the tab became visible again). */
  check(): void;
  /** Shows the survey now, without its triggers. Resolves to whether it was shown. */
  show(key: string): Promise<boolean>;
  /**
   * Keeps an Embed in `target` (an element or a CSS selector) while the
   * survey applies. Returns the function that removes it.
   */
  mount(key: string, target: Element | string): () => void;
  /** Closes every open survey and forgets the list (reset or identity change). Mounted embeds stay registered. */
  close(): void;
  /** Closes everything and removes every listener. */
  stop(): void;
}

/** Formats this version renders. */
export const RENDERED_FORMATS: readonly string[] = ["popup", "modal", "banner", "tooltip", "embed"];

/** Formats that compete for the screen: at most one of them is open. Tooltip and Embed do not. */
export const competes = (format: string): boolean => format === "popup" || format === "modal" || format === "banner";

const STEP_TYPES = ["message", "rating", "choice", "text", "thanks"];
const SCALES = ["nps", "ten", "stars", "emoji"];
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";

function validBranch(b: unknown, rating: boolean): boolean {
  if (!isObject(b) || !isText(b.key) || !Array.isArray(b.steps) || !b.steps.every((s) => validStep(s, false))) return false;
  return rating ? typeof b.min === "number" && typeof b.max === "number" : Array.isArray(b.optionKeys) && b.optionKeys.every(isText);
}

/** A step this renderer can draw; steps inside a branch may not branch again. */
function validStep(s: unknown, top: boolean): boolean {
  if (!isObject(s) || !isText(s.key) || !s.key || !STEP_TYPES.includes(s.type)) return false;
  if (!isText(s.title) || !isText(s.description ?? "") || !isText(s.button ?? "")) return false;
  if (s.branches !== undefined) {
    if (!top || (s.type !== "rating" && s.type !== "choice") || !Array.isArray(s.branches)) return false;
    if (!s.branches.every((b: unknown) => validBranch(b, s.type === "rating"))) return false;
  }
  if (s.type === "rating") return SCALES.includes(s.scale) && isText(s.lowLabel ?? "") && isText(s.highLabel ?? "");
  if (s.type === "choice") return Array.isArray(s.options) && s.options.every((o: unknown) => isObject(o) && isText(o.key) && isText(o.label));
  if (s.type === "text") return isText(s.placeholder ?? "");
  return true;
}

/**
 * True for a definition this version can show: a known format, a schema it
 * knows, and every field it reads of the right shape. Anything else is
 * skipped silently, never drawn half.
 */
export function isRenderable(survey: unknown): survey is SdkSurvey {
  if (!isObject(survey)) return false;
  const s = survey;
  return (
    isText(s.key) &&
    isText(s.versionId) &&
    typeof s.schema === "number" &&
    s.schema <= SURVEY_SCHEMA &&
    RENDERED_FORMATS.includes(s.format) &&
    isObject(s.design) &&
    Array.isArray(s.triggers) &&
    s.triggers.every(isObject) &&
    Array.isArray(s.steps) &&
    s.steps.length > 0 &&
    s.steps.every((step: unknown) => validStep(step, true))
  );
}
