export const SPATIAL_PLAN_VERSION = 1;
export const SPATIAL_PLANNER_VERSION = "5.0.0";

export const SPATIAL_STRENGTHS = ["conservative", "normal", "strong"] as const;
export type SpatialStrength = (typeof SPATIAL_STRENGTHS)[number];

export interface SpatialSettings {
  strength: SpatialStrength;
}

export const DEFAULT_SPATIAL_SETTINGS: SpatialSettings = { strength: "normal" };

export interface SpatialLimits {
  /** Largest automatic pan or balance move, in pan units (0.25 = 25%). */
  maxPanMove: number;
  /** Largest automatic width change, in width units (0.3 = 30 percentage points). */
  maxWidthChange: number;
  /** Pair conflicts below this are reported and left alone. */
  minConflict: number;
  /** A move must remove at least this much weighted conflict. */
  minBenefit: number;
  /** Width step a section note such as "wider" asks for. */
  intentWidthStep: number;
  /** Pan step a note such as "push the guitar left" asks for. */
  intentPanStep: number;
}

export const SPATIAL_LIMITS_BY_STRENGTH: Record<SpatialStrength, SpatialLimits> = {
  conservative: { maxPanMove: 0.15, maxWidthChange: 0.2, minConflict: 0.38, minBenefit: 0.11, intentWidthStep: 0.1, intentPanStep: 0.15 },
  normal: { maxPanMove: 0.25, maxWidthChange: 0.3, minConflict: 0.3, minBenefit: 0.08, intentWidthStep: 0.2, intentPanStep: 0.25 },
  strong: { maxPanMove: 0.4, maxWidthChange: 0.4, minConflict: 0.24, minBenefit: 0.05, intentWidthStep: 0.3, intentPanStep: 0.35 },
};

/** Automatic width stays inside this range whatever the strength. Outside it needs a person. */
export const AUTO_WIDTH_MIN = 0.6;
export const AUTO_WIDTH_MAX = 1.4;
/** Automatic pan never goes further out than this. Hard panning needs a person or an explicit note. */
export const AUTO_PAN_LIMIT = 0.8;

/** A stem whose measured correlation is under this is not widened automatically. */
export const WIDEN_MIN_CORRELATION = 0.2;
/** Widening may not take a stem's correlation under this. */
export const CORRELATION_FLOOR = 0.2;
/** A stem must be at least this decorrelated (1 − correlation as recorded) for width to change anything audible. */
export const MIN_STEREO_SPREAD = 0.04;
/** Mono fold-down loss (dB) a move may add to a stem before it is penalized, and the most it may add at all. */
export const MONO_LOSS_ALLOWANCE_DB = 0.5;
export const MONO_LOSS_LIMIT_DB = 1.5;
/** Left/right energy balance of the mix (|R − L| / (R + L)) a move may not push past. */
export const MIX_BALANCE_LIMIT = 0.3;
/** A stem with this much of its energy under 150 Hz is not panned or widened automatically. */
export const LOW_END_SHARE_LIMIT = 0.4;
/** A competitor this many dB louder than the protected stem in the conflict range has a level problem, not a spatial one. */
export const LEVEL_PROBLEM_DB = 6;

/** Two stems of the same tier compete for space only within this many dB of each other while both play. */
export const PEER_LEVEL_DB = 6;
/** A stem is a phase risk below this correlation: clearly negative, not merely decorrelated. */
export const PHASE_RISK_CORRELATION = -0.1;
/** A Background part narrower than this (1 − correlation as heard) is "mostly mono" and may be widened to surround the mix. */
export const SURROUND_MAX_SPREAD = 0.3;

/** Any of these sends a recommendation to review instead of Apply all. */
export const REVIEW_CONFIDENCE = 0.55;
export const REVIEW_PAN_MOVE = 0.4;
