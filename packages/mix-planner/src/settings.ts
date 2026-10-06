export const FULL_MIX_PLAN_VERSION = 1;
export const FULL_MIX_PLANNER_VERSION = "7.1.0";

export const MIX_STRENGTHS = ["conservative", "normal", "strong"] as const;
export type MixStrength = (typeof MIX_STRENGTHS)[number];

/**
 * An optional whole-mix goal. It only re-weights problems Audiosous already measures and tools it already has:
 * it never adds a processor on its own, and it is not a loudness or tone target.
 */
export const MIX_GOALS = ["balanced", "punchy", "open", "intimate", "wide", "controlled"] as const;
export type MixGoal = (typeof MIX_GOALS)[number];

export interface FullMixSettings {
  strength: MixStrength;
  goal: MixGoal;
}

export const DEFAULT_FULL_MIX_SETTINGS: FullMixSettings = { strength: "normal", goal: "balanced" };

export interface MixLimits {
  /** Planning passes (analyze → choose → evaluate → revise). Each pass is re-measured on the candidate. */
  maxIterations: number;
  /** A problem is acted on from this severity. Under it the problem is reported and left alone. */
  minSeverity: number;
  /** An intervention must be expected to remove at least this share of its problem. */
  minReduction: number;
  /** Benefit must beat cost by at least this much (benefit and cost share one unit, see `cost.ts`). */
  minNet: number;
  /** Most processors one problem may get. A second one has to earn its own place. */
  maxChangesPerProblem: number;
  /** Most combined processing cost the whole plan may carry. */
  maxTotalCost: number;
  /** Most changes the whole plan may carry; problems are taken in priority order, so the most important get them. */
  maxChanges: number;
  /** A pass must improve the candidate score by at least this much to be kept. */
  minPassGain: number;
  /** Below this confidence a problem only gets one small, cheap change, or none. */
  lowConfidence: number;
  /** Combined alternatives run each part at this share of its own depth. */
  comboDepth: number;
}

export const MIX_LIMITS_BY_STRENGTH: Record<MixStrength, MixLimits> = {
  conservative: { maxIterations: 2, maxChanges: 3, minSeverity: 0.5, minReduction: 0.3, minNet: 0.1, maxChangesPerProblem: 1, maxTotalCost: 0.6, minPassGain: 0.08, lowConfidence: 0.65, comboDepth: 0.6 },
  normal: { maxIterations: 3, maxChanges: 8, minSeverity: 0.38, minReduction: 0.2, minNet: 0.06, maxChangesPerProblem: 2, maxTotalCost: 1.2, minPassGain: 0.05, lowConfidence: 0.6, comboDepth: 0.65 },
  strong: { maxIterations: 4, maxChanges: 12, minSeverity: 0.32, minReduction: 0.15, minNet: 0.03, maxChangesPerProblem: 2, maxTotalCost: 2, minPassGain: 0.03, lowConfidence: 0.55, comboDepth: 0.7 },
};

/** Under this confidence a problem is left alone and the plan says why. */
export const MIN_PROBLEM_CONFIDENCE = 0.45;
/** Severity under which a problem counts as solved after the candidate. */
export const SOLVED_SEVERITY = 0.25;

/** Safety limits on the whole candidate, whatever the strength. */
export const SAFETY = {
  /** The candidate's estimated peak may not pass the current mix's or this ceiling, whichever is higher. */
  ceilingDbfs: -1,
  /** Largest safety trim the candidate may carry. */
  maxTrimDb: 6,
  /** Mono fold-down loss of the mix may not grow by more than this. */
  monoLossGrowthDb: 0.5,
  /** Mix correlation may not drop by more than this. */
  correlationDrop: 0.1,
  /** Combined predicted gain reduction on one stem (compressor + duck + dynamic EQ) past this is over-processing. */
  maxStemReductionDb: 8,
  /**
   * A stem's average level may not move more than this from processing that was not meant as a level change.
   * Smaller shifts are judged by re-measuring the level hierarchy: a stem that ends up too quiet is a new problem.
   */
  maxSideLevelShiftDb: 4,
  /** A section boundary's level step may not change by more than this. */
  transitionStepDb: 1.5,
} as const;

/** Whole-mix A/B plays the candidate at the current mix's estimated loudness, within this. */
export const MAX_LOUDNESS_MATCH_DB = 3;
