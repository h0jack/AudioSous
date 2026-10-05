export const EQ_PLAN_VERSION = 1;
export const EQ_PLANNER_VERSION = "4.0.0";

export const EQ_STRENGTHS = ["conservative", "normal", "strong"] as const;
export type EqStrength = (typeof EQ_STRENGTHS)[number];

export interface EqSettings {
  strength: EqStrength;
}

export const DEFAULT_EQ_SETTINGS: EqSettings = { strength: "normal" };

export interface EqLimits {
  /** Deepest automatic cut, as a positive number of dB. */
  maxCutDb: number;
  maxBoostDb: number;
  /** New track-wide filters the planner may add to one track. */
  maxGlobalFilters: number;
  /** New filters the planner may add to one Track × Section. */
  maxSectionFilters: number;
  /** Interactions below this severity are reported but not acted on. */
  minSeverity: number;
  /** Share of the measured level excess the planner tries to remove. */
  correctionMix: number;
  /** A move is kept only when its expected benefit beats its cost by this factor. */
  benefitRatio: number;
  /** Most a filter may take from its own track's overall level, dB. */
  maxIdentityLossDb: number;
}

export const EQ_LIMITS_BY_STRENGTH: Record<EqStrength, EqLimits> = {
  conservative: { maxCutDb: 2, maxBoostDb: 1, maxGlobalFilters: 2, maxSectionFilters: 1, minSeverity: 0.5, correctionMix: 0.4, benefitRatio: 1.4, maxIdentityLossDb: 0.6 },
  normal: { maxCutDb: 3.5, maxBoostDb: 2, maxGlobalFilters: 3, maxSectionFilters: 2, minSeverity: 0.4, correctionMix: 0.5, benefitRatio: 1, maxIdentityLossDb: 1 },
  strong: { maxCutDb: 6, maxBoostDb: 3, maxGlobalFilters: 3, maxSectionFilters: 2, minSeverity: 0.33, correctionMix: 0.6, benefitRatio: 0.8, maxIdentityLossDb: 1.5 },
};

/** Planner output stays inside these, whatever the strength. Wider settings need a person. */
export const AUTO_Q_MIN = 0.4;
export const AUTO_Q_MAX = 4;
/** Broad musical moves. Narrower Q is only used for a low-end fundamental. */
export const BROAD_Q_MAX = 2;
export const AUTO_MIN_CUT_DB = 0.5;

/** Any of these sends a recommendation to review instead of Apply all. */
export const REVIEW_CUT_DB = 4;
export const REVIEW_BOOST_DB = 2;
export const REVIEW_Q = 2.5;
export const REVIEW_CONFIDENCE = 0.55;

/** A competitor still this far above the protected part after the largest allowed cut is a level problem, not an EQ one. */
export const LEVEL_PROBLEM_DB = 6;
