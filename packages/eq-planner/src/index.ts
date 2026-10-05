export {
  AUTO_MIN_CUT_DB,
  AUTO_Q_MAX,
  AUTO_Q_MIN,
  BROAD_Q_MAX,
  DEFAULT_EQ_SETTINGS,
  EQ_LIMITS_BY_STRENGTH,
  EQ_PLAN_VERSION,
  EQ_PLANNER_VERSION,
  EQ_STRENGTHS,
  REVIEW_BOOST_DB,
  REVIEW_CONFIDENCE,
  REVIEW_CUT_DB,
  REVIEW_Q,
} from "./settings";
export type { EqLimits, EqSettings, EqStrength } from "./settings";

export {
  EDIT_LIMITS,
  applyEqPlan,
  checkRange,
  withProxyChecks,
  describeFilter,
  editEqRecommendation,
  eqAudition,
  eqAuditionChainAt,
  eqEvaluationSchema,
  eqPlanIsStale,
  eqPlanSchema,
  eqPlanStateIdentity,
  eqRecommendationIncluded,
  eqRecommendationSchema,
  evaluateFilter,
  formatHz,
  interactionSchema,
  needsReview,
  refreshEqTrim,
  resetEqRecommendation,
  sameFilter,
  setEqRecommendationStatus,
} from "./plan";
export type {
  EqApplyMode,
  ProxyCheck,
  EqAudition,
  EqAuditionOptions,
  EqEvaluation,
  EqEvidence,
  EqPlan,
  EqRecommendation,
  EqScope,
  InteractionRegionDto,
  MixPlanKind,
  TrackInteraction,
} from "./plan";

export { bandPowerGain, chainMagnitudeDb, filterMagnitudeDb, octavesForQ, qForOctaves, responseCurve, RESPONSE_SAMPLE_RATE } from "./response";
export { GRID_BANDS, bandGrid, buildSpectralModel } from "./spectra";
export type { SpectralModel, TrackSpectra } from "./spectra";
export { analyzeInteractions, maskCurve, regionWeight } from "./interaction";
export type { InteractionAnalysis, PairAnalysis } from "./interaction";
export { TONAL_WORDS, readTonalNotes, tonalEvidence } from "./tonal";
export { musicalFrequency, planEq } from "./planner";
export type { PlanEqInput } from "./planner";
