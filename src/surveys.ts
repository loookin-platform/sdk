// Entry of `@loookin/sdk/surveys`: the renderer the browser entry loads on demand.
export { startSurveys } from "./surveys/index";
export { mountSurveyPreview } from "./surveys/preview";
export type { SurveyPreview, SurveyPreviewOptions } from "./surveys/preview";
export type {
  SdkSurvey,
  Step,
  StepAnswer,
  SurveyDefinition,
  SurveyDesign,
  SurveyHost,
  SurveyIdentity,
  SurveysController,
  Trigger,
} from "./surveys/types";
