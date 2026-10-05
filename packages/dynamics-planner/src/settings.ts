export const DYNAMICS_PLAN_VERSION = 1;
export const DYNAMICS_PLANNER_VERSION = "6.0.0";

export const DYNAMICS_STRENGTHS = ["conservative", "normal", "strong"] as const;
export type DynamicsStrength = (typeof DYNAMICS_STRENGTHS)[number];

export interface DynamicsSettings {
  strength: DynamicsStrength;
}

export const DEFAULT_DYNAMICS_SETTINGS: DynamicsSettings = { strength: "normal" };

export interface DynamicsLimits {
  /** Gain reduction a compressor should apply on the loudest sustained passages (90th percentile), dB. */
  grTarget: { min: number; max: number };
  maxRatio: number;
  /** Largest automatic duck and dynamic EQ dip, dB (positive numbers; nodes store them negative). */
  maxDuckDb: number;
  maxDynamicEqDb: number;
  /** Largest automatic transient amount, as a fraction (0.2 = 20%). */
  maxTransient: number;
  /** Added to every level-spread threshold: Conservative waits for more spread, Strong reacts to less. */
  spreadAllowanceDb: number;
  /** A problem's severity must reach this before a processor is considered. */
  minSeverity: number;
  /** Share of the gap a keyed move closes, like the EQ planner's cut sizing. */
  moveShare: number;
}

export const DYNAMICS_LIMITS_BY_STRENGTH: Record<DynamicsStrength, DynamicsLimits> = {
  conservative: { grTarget: { min: 1, max: 2.5 }, maxRatio: 2.5, maxDuckDb: 1.5, maxDynamicEqDb: 1.5, maxTransient: 0.12, spreadAllowanceDb: 1, minSeverity: 0.45, moveShare: 0.4 },
  normal: { grTarget: { min: 2, max: 4 }, maxRatio: 3, maxDuckDb: 2.5, maxDynamicEqDb: 2.5, maxTransient: 0.2, spreadAllowanceDb: 0, minSeverity: 0.35, moveShare: 0.5 },
  strong: { grTarget: { min: 2.5, max: 6 }, maxRatio: 4, maxDuckDb: 4, maxDynamicEqDb: 4, maxTransient: 0.3, spreadAllowanceDb: -1, minSeverity: 0.28, moveShare: 0.6 },
};

/** The ranges Audiosous sets on its own, whatever the strength. Edits outside them go to review. */
export const AUTO_RANGES = {
  minRatio: 1.2,
  maxRatio: 4,
  minAttackMs: 3,
  maxAttackMs: 80,
  minReleaseMs: 40,
  maxReleaseMs: 500,
  maxKneeDb: 12,
  minDuckDb: 0.5,
  maxDuckDb: 4,
  minDynamicEqDb: 0.5,
  maxDynamicEqDb: 4,
  minQ: 0.5,
  maxQ: 3,
  maxTransientAttack: 0.3,
  maxTransientSustain: 0.2,
} as const;

/** Any of these sends a recommendation to review instead of Apply all. */
export const REVIEW_CONFIDENCE = 0.55;
/** A duck deeper than this is audible as an effect, not a separation; it waits for a person. */
export const REVIEW_DUCK_DB = 3;
export const REVIEW_DYNAMIC_EQ_DB = 3;
/** Sustained reduction past this is heavy compression. */
export const REVIEW_GR_DB = 6;
/** Automatic transient moves stay at or under this; larger ones are reviewed. */
export const REVIEW_TRANSIENT = 0.2;

/**
 * Level-spread thresholds by role, dB: the spread of a stem's sustained level (90th minus 10th percentile of
 * 400 ms windows) past which it reads as unstable rather than phrased. Sustained foundation parts are expected
 * to sit steady; voices and leads phrase more; drums are spiky by nature and their sustained level is not
 * what a compressor is for.
 */
export const SPREAD_THRESHOLD_DB: Record<string, number> = {
  bass: 5,
  synth: 6,
  pad: 6,
  keys: 6.5,
  guitar: 6.5,
  strings: 7.5,
  brass: 7,
  "backing-vocal": 7,
  vocal: 7,
  lead: 7,
  atmosphere: 8,
  fx: 9,
  drums: 8,
  kick: 9,
  "snare-clap": 9,
  "hi-hat": 9,
  percussion: 9,
  other: 7,
};

/** Window-to-window jumps of more than this count as a swing, not a phrase. */
export const SWING_DB = 3;
/** Share of window-to-window steps that must be swings for the spread to be instability rather than a swell. */
export const MIN_SWING_RATE = 0.2;
/** A stem needs at least this many sustained-level windows (400 ms each) in a scope to be judged there. */
export const MIN_WINDOWS = 12;

/** Kick/bass collision: the bass counts as colliding on a hit when its low band is within this of the kick's. */
export const COLLISION_GAP_DB = -3;
/** Share of the kick's hits (while the bass plays) that must collide before a duck is considered. */
export const MIN_COLLISION_SHARE = 0.4;

/**
 * Event masking: the protected part must leave the supporting part alone for at least this share of the
 * supporting part's playing time, or the conflict is persistent and static EQ is the right class of tool.
 */
export const MIN_FREE_SHARE = 0.35;
