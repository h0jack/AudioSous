import { dynamicsEvaluationSchema, dynamicsProcessingSchema, dynamicsRecommendationSchema } from "@audiosous/dynamics-planner";
import { eqEvaluationSchema, eqRecommendationSchema } from "@audiosous/eq-planner";
import { eqFilterSchema } from "@audiosous/project-model";
import { spatialPlanSchema } from "@audiosous/spatial-planner";
import { z } from "zod";
import { FULL_MIX_PLAN_VERSION, FULL_MIX_PLANNER_VERSION, MIX_GOALS, MIX_STRENGTHS } from "./settings";

const finite = z.number().finite();
const unit = finite.min(0).max(1);

export const scopeSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("global") }), z.object({ type: z.literal("section"), sectionId: z.string().min(1) })]);
export type MixScope = z.infer<typeof scopeSchema>;

/* ------------------------------------------------------------------ problems */

export const MIX_PROBLEM_TYPES = [
  "headroom",
  "level-hierarchy",
  "frequency-conflict",
  "low-end-collision",
  "event-masking",
  "dynamic-instability",
  "transient-problem",
  "center-congestion",
  "excessive-width",
  "section-contrast",
  "intent",
] as const;
export type MixProblemType = (typeof MIX_PROBLEM_TYPES)[number];

export const PROBLEM_LABELS: Record<MixProblemType, string> = {
  headroom: "Headroom",
  "level-hierarchy": "Level hierarchy",
  "frequency-conflict": "Frequency conflict",
  "low-end-collision": "Low-end collision",
  "event-masking": "Event masking",
  "dynamic-instability": "Level instability",
  "transient-problem": "Transient balance",
  "center-congestion": "Center congestion",
  "excessive-width": "Width / mono safety",
  "section-contrast": "Section contrast",
  intent: "Section intent",
};

/**
 * Problems are solved in this order: a stem 10 dB too loud is fixed before frequency, dynamics, or space is
 * judged around it, and contrast is refined last.
 */
export const PROBLEM_GROUP: Record<MixProblemType, number> = {
  headroom: 1,
  "level-hierarchy": 1,
  "frequency-conflict": 2,
  "low-end-collision": 2,
  "event-masking": 3,
  "dynamic-instability": 3,
  "transient-problem": 3,
  "center-congestion": 4,
  "excessive-width": 4,
  "section-contrast": 5,
  intent: 5,
};

export const DOMAINS = ["gain", "eq", "space", "dynamics", "trim"] as const;
export type MixDomain = (typeof DOMAINS)[number];
export const SOURCES = ["level", "eq", "space", "dynamics", "full-mix"] as const;
export type MixSource = (typeof SOURCES)[number];

export const problemEvidenceSchema = z.object({
  /** Which measurement said so. */
  source: z.enum(SOURCES),
  label: z.string().min(1).max(80),
  detail: z.string().min(1).max(600),
  value: finite.nullable(),
  unit: z.string().max(12).nullable(),
});
export type ProblemEvidence = z.infer<typeof problemEvidenceSchema>;

export const problemOutcomeSchema = z.enum(["solved", "improved", "unchanged", "left-alone", "deferred"]);
export type ProblemOutcome = z.infer<typeof problemOutcomeSchema>;

export const mixProblemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(MIX_PROBLEM_TYPES),
  title: z.string().min(1).max(160),
  /** Global when the problem spans the song; a section when it is confined to one. */
  scope: scopeSchema,
  /** Sections where it was measured past threshold (empty for whole-song readings). */
  sectionIds: z.array(z.string()).max(32),
  trackIds: z.array(z.string().min(1)).min(0).max(8),
  /** The stem the problem hurts, and the one that would normally give way (role hierarchy). */
  protectedTrackId: z.string().nullable(),
  yieldingTrackId: z.string().nullable(),
  severity: unit,
  confidence: unit,
  /** Planning priority: 1 level and headroom, 2 persistent frequency, 3 time-domain, 4 space, 5 contrast and intent. */
  group: z.number().int().min(1).max(5),
  /** Subsystem interaction or row ids this problem was read from. */
  references: z.array(z.string()).max(32),
  evidence: z.array(problemEvidenceSchema).min(1).max(8),
  /** Severity measured again on the final candidate. Null when the plan did not touch it. */
  severityAfter: unit.nullable(),
  outcome: problemOutcomeSchema,
  /** The selected solution, null when nothing was selected. */
  interventionId: z.string().nullable(),
  explanation: z.string().min(1).max(800),
  /** First pass that saw it (1-based). */
  pass: z.number().int().min(1).max(8),
});
export type MixProblem = z.infer<typeof mixProblemSchema>;

/* ------------------------------------------------------------------ changes */

const eqEvidenceSchema = eqRecommendationSchema.shape.evidence;
const spatialRecommendationShape = spatialPlanSchema.shape.changes.element.shape;
const spatialEvidenceSchema = spatialRecommendationShape.evidence;
const spatialEvaluationSchema = spatialRecommendationShape.evaluation.unwrap();
const dynamicsEvidenceSchema = dynamicsRecommendationSchema.shape.evidence;

export const changeProcessingSchema = z.discriminatedUnion("type", [
  /** Absolute fader (global) or Track × Section gain (section) and the move it makes. */
  z.object({ type: z.literal("gain"), gainDb: finite, deltaDb: finite }),
  /** Safety trim on every fader and section gain, keeping the relative balance. */
  z.object({ type: z.literal("trim"), gainDb: finite }),
  z.object({ type: z.literal("eq"), filter: eqFilterSchema }),
  /** Null leaves that control as it is. */
  z.object({ type: z.literal("spatial"), pan: finite.min(-1).max(1).nullable(), width: finite.min(0).max(2).nullable() }),
  z.object({ type: z.literal("dynamics"), processing: dynamicsProcessingSchema }),
]);
export type ChangeProcessing = z.infer<typeof changeProcessingSchema>;

/** What a change was judged on, so an edit is re-checked with its subsystem's own evaluator and no audio. */
export const changeEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("eq"), purpose: eqRecommendationSchema.shape.purpose, evidence: eqEvidenceSchema }),
  z.object({ kind: z.literal("space"), current: z.object({ pan: finite, width: finite }), evidence: spatialEvidenceSchema }),
  z.object({
    kind: z.literal("dynamics"),
    problem: dynamicsRecommendationSchema.shape.problem,
    targetReductionDb: z.object({ min: finite, max: finite }).nullable(),
    evidence: dynamicsEvidenceSchema,
  }),
  z.object({ kind: z.literal("level"), currentGainDb: finite }),
]);
export type ChangeEvidence = z.infer<typeof changeEvidenceSchema>;

export const changeEvaluationSchema = z.object({
  /** One line in words, as the review panel shows it. */
  summary: z.string().max(400),
  /** Share of its problem this change is expected to remove on its own (local, from its evidence). */
  reduction: unit,
  /** Predicted change of the stem's average level where it plays, dB. */
  levelChangeDb: finite,
  /** Predicted change of the stem's peak (boosts, widening, makeup), dB; 0 when it cannot rise. */
  peakChangeDb: finite,
  /** Largest predicted gain reduction this change applies, dB (dynamics). */
  reductionMaxDb: finite,
  /** Level change where the problem is absent (between hits, while the protected part rests), dB. */
  outsideChangeDb: finite.nullable(),
  /** Price paid outside the problem (heard everywhere, between hits, while the protected part rests), benefit units. */
  collateral: finite.min(0),
  /** The subsystem evaluation, for the detail view. */
  eq: eqEvaluationSchema.nullable(),
  space: spatialEvaluationSchema.nullable(),
  dynamics: dynamicsEvaluationSchema.nullable(),
});
export type ChangeEvaluation = z.infer<typeof changeEvaluationSchema>;

export const changeStatusSchema = z.enum(["proposed", "accepted", "rejected", "needs-review"]);
export type ChangeStatus = z.infer<typeof changeStatusSchema>;

export const mixChangeSchema = z.object({
  id: z.string().min(1),
  /** Problems this change works on. One change may serve several. */
  problemIds: z.array(z.string().min(1)).min(1).max(8),
  trackId: z.string().min(1),
  scope: scopeSchema,
  domain: z.enum(DOMAINS),
  /** Which planner proposed it; full-mix for gain alternatives, safety trim, and combined depths. */
  source: z.enum(SOURCES),
  processing: changeProcessingSchema,
  /** As planned, so an edit can be compared and reset. */
  planned: changeProcessingSchema,
  /** A saved node this change edits instead of adding another. */
  replacesNodeId: z.string().nullable(),
  /** The current setting in words ("0.0 dB", "width 130%", "no compressor"). */
  current: z.string().max(200),
  cost: finite.min(0),
  confidence: unit,
  confidenceLabel: z.enum(["high", "medium", "low"]),
  status: changeStatusSchema,
  edited: z.boolean(),
  reasons: z.array(z.string().min(1).max(600)).min(1).max(6),
  warnings: z.array(z.string().max(300)).max(6),
  evaluation: changeEvaluationSchema,
  evidence: changeEvidenceSchema,
});
export type MixChange = z.infer<typeof mixChangeSchema>;

/* ------------------------------------------------------------------ interventions */

export const interventionOutcomeSchema = z.enum(["selected", "rejected", "redundant", "regression", "not-needed"]);

export const mixInterventionSchema = z.object({
  id: z.string().min(1),
  problemIds: z.array(z.string().min(1)).min(1).max(8),
  /** "Bass duck from Kick + Bass EQ −0.7 dB at 82 Hz". */
  label: z.string().min(1).max(240),
  kind: z.enum(["single", "combined", "none"]),
  /** Each processing move in words, per stem: what a reader needs to understand a rejected alternative. */
  items: z.array(z.object({ trackId: z.string(), domain: z.enum(DOMAINS), description: z.string().max(200) })).max(4),
  /** Selected changes, by id in `changes`. Empty for alternatives that were not chosen. */
  changeIds: z.array(z.string()).max(4),
  cost: finite.min(0),
  confidence: unit,
  /** Share of the problem it is expected to remove, on the problem's own evidence. */
  expectedReduction: unit,
  /** Benefit minus cost and collateral, in the planner's one unit. */
  net: finite,
  outcome: interventionOutcomeSchema,
  reason: z.string().min(1).max(600),
});
export type MixIntervention = z.infer<typeof mixInterventionSchema>;

/* ------------------------------------------------------------------ evaluation */

export const candidateMetricsSchema = z.object({
  /** Confidence- and priority-weighted severity summed over the plan's problems. Not a quality score. */
  problemScore: finite.min(0),
  /** Problems still past their threshold. */
  openProblems: z.number().int().nonnegative(),
  /** Estimated sum peak (power sum of stem peaks + 1 dB), dBFS. */
  estimatedPeakDbfs: finite.nullable(),
  /** Estimated mix loudness (power sum of stem loudness at their faders and processing), dB. */
  loudnessDb: finite.nullable(),
  correlation: finite.min(-1).max(1).nullable(),
  monoLossDb: finite.nullable(),
  centerLoad: unit.nullable(),
  /** Largest combined predicted reduction on any stem, dB. */
  maxReductionDb: finite.min(0),
  /** Largest unintended average-level shift on any stem, dB. */
  maxSideShiftDb: finite.min(0),
  processingCost: finite.min(0),
  changeCount: z.number().int().nonnegative(),
});
export type CandidateMetrics = z.infer<typeof candidateMetricsSchema>;

export const regressionSchema = z.object({
  kind: z.enum(["problem", "new-problem", "headroom", "mono", "dynamics", "level-shift", "transition"]),
  trackIds: z.array(z.string()).max(8),
  description: z.string().min(1).max(600),
  resolution: z.enum(["removed", "reduced", "trimmed", "accepted", "reported"]),
});
export type Regression = z.infer<typeof regressionSchema>;

export const fullMixEvaluationSchema = z.object({
  method: z.literal("re-measured"),
  before: candidateMetricsSchema,
  after: candidateMetricsSchema,
  /** The whole-mix candidates of the first pass, as scored. */
  candidates: z
    .array(
      z.object({
        name: z.enum(["minimal", "balanced", "assertive"]),
        changeCount: z.number().int().nonnegative(),
        cost: finite.min(0),
        problemScore: finite.min(0),
        regressions: z.number().int().nonnegative(),
        score: finite,
        chosen: z.boolean(),
      }),
    )
    .max(4),
  passes: z
    .array(
      z.object({
        pass: z.number().int().min(1),
        problems: z.number().int().nonnegative(),
        selected: z.number().int().nonnegative(),
        scoreBefore: finite,
        scoreAfter: finite,
        kept: z.boolean(),
        note: z.string().max(300),
      }),
    )
    .max(8),
  stopReason: z.string().min(1).max(300),
  regressions: z.array(regressionSchema).max(24),
  /** The same project planned by the four planners on their own, for comparison. */
  independent: z.object({ level: z.number().int().nonnegative(), eq: z.number().int().nonnegative(), space: z.number().int().nonnegative(), dynamics: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  /** Planner runs it took (each a measurement of one candidate by one planner). */
  surveys: z.number().int().nonnegative(),
});
export type FullMixEvaluation = z.infer<typeof fullMixEvaluationSchema>;

export const fullMixPlanSchema = z.object({
  planVersion: z.literal(FULL_MIX_PLAN_VERSION),
  plannerVersion: z.literal(FULL_MIX_PLANNER_VERSION),
  kind: z.literal("full-mix"),
  createdAt: z.string().min(1),
  projectId: z.string().min(1),
  sourceAnalysisVersion: z.string().min(1),
  settings: z.object({ strength: z.enum(MIX_STRENGTHS), goal: z.enum(MIX_GOALS) }),
  stateIdentity: z.string().min(1),
  summary: z.object({
    headline: z.string().min(1).max(300),
    /** Short lines: selected, rejected, cost, safety. */
    lines: z.array(z.string().max(300)).max(8),
    notes: z.array(z.string().max(600)).max(12),
    confidence: unit,
    confidenceLabel: z.enum(["high", "medium", "low"]),
    problemCount: z.number().int().nonnegative(),
    changeCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
    reviewCount: z.number().int().nonnegative(),
    processing: z.object({
      gain: z.number().int().nonnegative(),
      eq: z.number().int().nonnegative(),
      space: z.number().int().nonnegative(),
      compressor: z.number().int().nonnegative(),
      ducking: z.number().int().nonnegative(),
      transient: z.number().int().nonnegative(),
      dynamicEq: z.number().int().nonnegative(),
      trim: z.number().int().nonnegative(),
    }),
    costLabel: z.enum(["none", "low", "low/moderate", "moderate", "high"]),
  }),
  problems: z.array(mixProblemSchema).max(64),
  interventions: z.array(mixInterventionSchema).max(256),
  changes: z.array(mixChangeSchema).max(96),
  evaluation: fullMixEvaluationSchema,
  /** Safety trim on every fader. `renderedDb` is the least trim the rendered check asked for; edits never go above it. */
  candidateTrim: z.object({ gainDb: finite, reason: z.string().nullable(), renderedDb: finite.nullable() }),
  /** Per stem, for headroom and loudness estimates after edits. */
  levels: z.array(
    z.object({
      trackId: z.string().min(1),
      loudnessDb: finite.nullable(),
      peakDbfs: finite.nullable(),
      gainDb: finite,
      muted: z.boolean(),
    }),
  ),
});
export type FullMixPlan = z.infer<typeof fullMixPlanSchema>;
