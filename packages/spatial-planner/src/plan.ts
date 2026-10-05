import { ANALYSIS_ENGINE_VERSION, STEREO_BANDS, STEREO_FRAMES_VERSION } from "@audiosous/analysis-contract";
import { confidenceLabel, estimateSumPeakDbfs, formatSignedDb, headroomTrimDb, type SourceFingerprint } from "@audiosous/balance-planner";
import {
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  SPATIAL_LIMITS,
  normalizePan,
  normalizeWidth,
  processingIdentity,
  sectionSettingInUse,
  setSectionSpatial,
  setTrackSpatial,
  spatialIdentity,
  withUpdatedAt,
  type ProjectDocument,
} from "@audiosous/project-model";
import { z } from "zod";
import { prepareOther, readConflict, type PreparedOther } from "./conflict";
import {
  AUTO_PAN_LIMIT,
  AUTO_WIDTH_MAX,
  AUTO_WIDTH_MIN,
  CORRELATION_FLOOR,
  MIX_BALANCE_LIMIT,
  MONO_LOSS_LIMIT_DB,
  REVIEW_CONFIDENCE,
  REVIEW_PAN_MOVE,
  SPATIAL_PLAN_VERSION,
  SPATIAL_PLANNER_VERSION,
  SPATIAL_STRENGTHS,
  type SpatialSettings,
} from "./settings";
import { addLrc, equalPowerPan, fieldShares, imageOf, occupancy, placeStats, stereoPower, type Lrc, type SpatialSetting } from "./stereo";

const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("section"), sectionId: z.string().min(1) }),
]);

export type SpatialScope = z.infer<typeof scopeSchema>;

const finite = z.number().finite();
/** [left, right, cross] power per stereo band. */
const bandStatsSchema = z.array(z.tuple([finite, finite, finite])).length(STEREO_BANDS);
const settingSchema = z.object({ pan: finite.min(-1).max(1), width: finite.min(0).max(2) });

const imageSchema = z.object({
  position: finite.min(-1).max(1),
  spread: finite.min(0).max(1),
  correlation: finite.min(-1).max(1),
  sideShare: finite.min(0).max(1),
  monoLossDb: finite.min(0).max(40),
  msRatioDb: finite,
});

export type ImageDto = z.infer<typeof imageSchema>;

/**
 * What a recommendation was judged on, so an edit can be re-checked without the planner.
 * One entry per scope the row affects: the moving stem's statistics before width and pan, the rest of
 * the mix as heard, and each stem it was separated from.
 */
const evidenceSchema = z.object({
  mono: z.boolean(),
  edgesHz: z.array(finite.positive()).length(STEREO_BANDS + 1),
  scopes: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string(),
        sectionId: z.string().nullable(),
        /** Share of the stem's active time in this scope, summing to 1 across scopes. */
        weight: finite.min(0).max(1),
        /** Saved section override values that win over a whole-song change here. */
        override: z.object({ pan: finite.nullable(), width: finite.nullable() }),
        /** Pan and width the planner assumed in this scope before this row (saved state plus earlier rows of the plan). */
        baseline: settingSchema,
        target: bandStatsSchema,
        /** Everything else playing, summed, as heard. */
        rest: bandStatsSchema,
        /** Center-weighted power of the rest of the mix, per band, so a mix center load can be read. */
        restCenter: z.array(finite.min(0)).length(STEREO_BANDS),
        pairs: z
          .array(
            z.object({
              trackId: z.string().min(1),
              interactionId: z.string().min(1),
              /** A significant conflict this stem should give way in. Other pairs only count if the move makes them worse. */
              addressed: z.boolean(),
              priority: finite.min(0).max(1),
              weights: z.array(finite.min(0).max(1)).length(STEREO_BANDS),
              frequency: finite.min(0).max(1),
              activity: finite.min(0).max(1),
              target: bandStatsSchema,
              other: bandStatsSchema,
            }),
          )
          .max(8),
      }),
    )
    .max(24),
  /** Co-active windows, seconds, for checking on the playback proxy. */
  windows: z.array(z.tuple([finite.nonnegative(), finite.nonnegative()])).max(24),
});

export type SpatialEvidence = z.infer<typeof evidenceSchema>;

const mixMetricsSchema = z.object({
  /** Share of the mix's energy in the center of the field, energy-weighted over the scopes. */
  centerLoad: finite.min(0).max(1),
  /** Largest |R − L| / (R + L) of the mix over the scopes. */
  balance: finite.min(0).max(1),
  correlation: finite.min(-1).max(1),
  monoLossDb: finite.min(0).max(40),
});

export type MixMetrics = z.infer<typeof mixMetricsSchema>;

export const spatialEvaluationSchema = z.object({
  method: z.literal("stereo-statistics"),
  /** Priority-weighted conflict in the pairs this row addresses, before and after. */
  conflictBefore: finite.min(0),
  conflictAfter: finite.min(0),
  /** Conflict the row adds to other pairs by moving into their space. */
  collateral: finite.min(0),
  overlapBefore: finite.min(0).max(1),
  overlapAfter: finite.min(0).max(1),
  /** Share of this stem's energy in the center of the field. */
  centerBefore: finite.min(0).max(1),
  centerAfter: finite.min(0).max(1),
  correlationBefore: finite.min(-1).max(1),
  correlationAfter: finite.min(-1).max(1),
  monoLossBeforeDb: finite.min(0).max(40),
  monoLossAfterDb: finite.min(0).max(40),
  mixBefore: mixMetricsSchema,
  mixAfter: mixMetricsSchema,
  /** Change of this stem's stereo level from the width change. */
  levelChangeDb: finite,
  passes: z.number().int().min(0).max(2),
  proxy: z
    .object({
      correlationBefore: finite.min(-1).max(1),
      correlationAfter: finite.min(-1).max(1),
      monoLossBeforeDb: finite,
      monoLossAfterDb: finite,
      peakChangeDb: finite,
      seconds: finite.nonnegative(),
      agrees: z.boolean(),
    })
    .nullable(),
});

export type SpatialEvaluation = z.infer<typeof spatialEvaluationSchema>;

export const spatialRecommendationSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  scope: scopeSchema,
  /** Values this row sets. Null leaves that control as it is. A section row writes Track × Section overrides. */
  processing: z.object({ type: z.literal("spatial"), pan: finite.min(-1).max(1).nullable(), width: finite.min(0).max(2).nullable() }),
  /** Pan and width in effect in this scope in the saved project. */
  current: settingSchema,
  /** The row as planned, kept so an edit can be compared and reset. */
  planned: z.object({ pan: finite.nullable(), width: finite.nullable() }),
  /** A section row that edits a saved section override instead of adding one. */
  replacesOverride: z.boolean(),
  relatedTrackIds: z.array(z.string()).max(4),
  interactionIds: z.array(z.string()).max(8),
  purpose: z.enum(["separation", "widen", "narrow", "mono-safety", "intent"]),
  confidence: finite.min(0).max(1),
  confidenceLabel: z.enum(["high", "medium", "low"]),
  status: z.enum(["proposed", "accepted", "rejected", "needs-review"]),
  edited: z.boolean(),
  reasons: z.array(z.string().min(1).max(600)).min(1).max(6),
  /** Safety notes from the last check: mono fold-down, correlation, balance, range. */
  warnings: z.array(z.string().max(300)).max(4),
  evaluation: spatialEvaluationSchema.nullable(),
  evidence: evidenceSchema,
});

export type SpatialRecommendation = z.infer<typeof spatialRecommendationSchema>;

export const spatialInteractionSchema = z.object({
  id: z.string().min(1),
  scope: scopeSchema,
  scopeName: z.string(),
  trackA: z.string().min(1),
  trackB: z.string().min(1),
  tierA: z.string(),
  tierB: z.string(),
  centerCompetition: finite.min(0).max(1),
  stereoOverlap: finite.min(0).max(1),
  frequencyOverlap: finite.min(0).max(1),
  simultaneousActivity: finite.min(0).max(1),
  severity: finite.min(0).max(1),
  confidence: finite.min(0).max(1),
  imageA: imageSchema,
  imageB: imageSchema,
  /** Where the two compete, the bands carrying most of the frequency competition. */
  lowHz: finite.positive(),
  highHz: finite.positive(),
  /** Moving stem minus protected stem, dB, in those bands while both play. */
  levelGapDb: finite,
  protectedTrackId: z.string().nullable(),
  movingTrackId: z.string().nullable(),
  outcome: z.enum(["recommendation", "review", "below-threshold", "anchors", "no-priority", "level", "eq", "no-benefit", "intent"]),
  explanation: z.string().min(1).max(600),
});

export type SpatialInteraction = z.infer<typeof spatialInteractionSchema>;

export const spatialPlanSchema = z.object({
  planVersion: z.literal(SPATIAL_PLAN_VERSION),
  plannerVersion: z.literal(SPATIAL_PLANNER_VERSION),
  kind: z.literal("spatial-balance"),
  createdAt: z.string().min(1),
  projectId: z.string().min(1),
  sourceAnalysisVersion: z.string().min(1),
  settings: z.object({ strength: z.enum(SPATIAL_STRENGTHS) }),
  stateIdentity: z.string().min(1),
  summary: z.object({
    goal: z.literal("separation"),
    confidence: finite.min(0).max(1),
    headline: z.string().min(1),
    notes: z.array(z.string()).max(10),
    changeCount: z.number().int().nonnegative(),
    reviewCount: z.number().int().nonnegative(),
    pairsAnalyzed: z.number().int().nonnegative(),
    analysisSource: z.string(),
  }),
  changes: z.array(spatialRecommendationSchema).max(64),
  interactions: z.array(spatialInteractionSchema).max(48),
  /** Where every stem sits in each scope as the mix is now, for the stereo field view. */
  fields: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string(),
        sectionId: z.string().nullable(),
        tracks: z.array(z.object({ trackId: z.string().min(1), image: imageSchema, levelDb: finite, tier: z.string(), mono: z.boolean() })).max(64),
      }),
    )
    .max(24),
  mix: z.object({ before: mixMetricsSchema, after: mixMetricsSchema }),
  candidateTrim: z.object({ gainDb: finite, reason: z.string().nullable() }),
  levels: z.array(
    z.object({
      trackId: z.string().min(1),
      peakDbfs: finite.nullable(),
      muted: z.boolean(),
      gainDb: finite,
      mono: z.boolean(),
      /** Whole-song [left, right, cross] power before the fader and spatial stage, for the per-channel headroom estimate. */
      stats: z.tuple([finite, finite, finite]),
      current: settingSchema,
    }),
  ),
});

export type SpatialPlan = z.infer<typeof spatialPlanSchema>;

/* ------------------------------------------------------------------ identity */

export function spatialPlanStateIdentity(document: ProjectDocument, settings: SpatialSettings, fingerprints: SourceFingerprint[] = []): string {
  const files = new Map(fingerprints.map((file) => [file.trackId, file]));
  const payload = {
    projectId: document.project.id,
    analysis: ANALYSIS_ENGINE_VERSION,
    stereo: STEREO_FRAMES_VERSION,
    planner: SPATIAL_PLANNER_VERSION,
    settings,
    tracks: document.tracks.map((track) => {
      const file = files.get(track.id);
      return [
        track.id,
        track.name,
        track.customLabel,
        track.role,
        track.gainDb,
        track.muted,
        track.metadata.durationSeconds,
        file?.fileSizeBytes ?? track.metadata.fileSizeBytes,
        file?.modifiedAtNs ?? "",
      ];
    }),
    sections: document.sections.map((section) => [section.id, section.startTime, section.endTime, section.type, section.userIntent]),
    rows: [...document.sectionTrackSettings]
      .sort((left, right) => `${left.trackId}:${left.sectionId}`.localeCompare(`${right.trackId}:${right.sectionId}`))
      .map((row) => [row.trackId, row.sectionId, row.prominence, row.userIntent, row.overrides.gainDb]),
    spatial: spatialIdentity(document),
    // EQ changes which conflicts remain, so a saved filter edit makes a spatial plan stale.
    processing: processingIdentity(document),
  };
  return fnv1a(JSON.stringify(payload));
}

export function spatialPlanIsStale(plan: SpatialPlan, document: ProjectDocument, fingerprints: SourceFingerprint[] = [], settings: SpatialSettings = plan.settings): boolean {
  return plan.projectId !== document.project.id || plan.stateIdentity !== spatialPlanStateIdentity(document, settings, fingerprints);
}

/* ------------------------------------------------------------------ status, edit */

export type SpatialApplyMode = "all" | "accepted";

/** Same rule as AutoBalance and EQ: rejected never, needs-review only once accepted, Apply accepted takes accepted only. */
export function spatialRecommendationIncluded(change: Pick<SpatialRecommendation, "status">, mode: SpatialApplyMode | "preview"): boolean {
  if (change.status === "rejected") return false;
  if (mode === "accepted") return change.status === "accepted";
  if (change.status === "needs-review") return false;
  return change.status === "proposed" || change.status === "accepted";
}

export function spatialRecommendationId(trackId: string, scope: SpatialScope): string {
  return `${trackId}::${scope.type === "global" ? "global" : `section::${scope.sectionId}`}::space`;
}

export function setSpatialRecommendationStatus(plan: SpatialPlan, id: string, status: SpatialRecommendation["status"]): SpatialPlan {
  return refreshSpatialTrim({ ...plan, changes: plan.changes.map((change) => (change.id === id ? { ...change, status } : change)) });
}

/** Edit bounds in the review panel: the full stored range. Values outside the automatic range get a warning. */
export const SPATIAL_EDIT_LIMITS = {
  minPan: SPATIAL_LIMITS.minPan,
  maxPan: SPATIAL_LIMITS.maxPan,
  minWidth: SPATIAL_LIMITS.minWidth,
  maxWidth: SPATIAL_LIMITS.maxWidth,
} as const;

/**
 * Applies an edit to one recommendation and re-checks it against its stored evidence: conflict,
 * correlation, mono fold-down, mix balance, and headroom. The planner does not run again.
 */
export function editSpatialRecommendation(plan: SpatialPlan, id: string, patch: { pan?: number | null; width?: number | null }): SpatialPlan {
  const changes = plan.changes.map((change) => {
    if (change.id !== id) return change;
    const pan = patch.pan === undefined ? change.processing.pan : patch.pan === null ? null : normalizePan(patch.pan);
    const width = patch.width === undefined ? change.processing.width : patch.width === null ? null : normalizeWidth(patch.width);
    const processing = { type: "spatial" as const, pan, width };
    const edited = pan !== change.planned.pan || width !== change.planned.width;
    const evaluation = change.evaluation
      ? { ...evaluateSpatial(change.evidence, processing, change.scope.type === "global"), passes: change.evaluation.passes, proxy: edited ? null : change.evaluation.proxy }
      : null;
    const warnings = evaluation ? safetyWarnings(change, processing, evaluation) : [];
    // An edit that trips a safety check does not ride along with Apply all; it needs an explicit accept.
    const status = change.status === "proposed" && warnings.length > 0 ? ("needs-review" as const) : change.status;
    return { ...change, processing, edited, evaluation, warnings, status };
  });
  return refreshSpatialTrim({ ...plan, changes });
}

export function resetSpatialRecommendation(plan: SpatialPlan, id: string): SpatialPlan {
  const change = plan.changes.find((item) => item.id === id);
  if (!change) return plan;
  return editSpatialRecommendation(plan, id, change.planned);
}

/* ------------------------------------------------------------------ evaluation */

/** The setting a row produces in one evidence scope: the row's values where it sets them, a saved override where one wins. */
export function settingInScope(scope: SpatialEvidence["scopes"][number], processing: { pan: number | null; width: number | null }, global: boolean): SpatialSetting {
  const pan = processing.pan ?? scope.baseline.pan;
  const width = processing.width ?? scope.baseline.width;
  if (!global) return { pan, width };
  return { pan: scope.override.pan ?? pan, width: scope.override.width ?? width };
}

export function toLrc(values: Array<[number, number, number]>): Lrc[] {
  return values.map(([l, r, c]) => ({ l, r, c }));
}

interface CompiledScope {
  target: Lrc[];
  rest: Lrc[];
  pairs: Array<{ input: Parameters<typeof readConflict>[0]; prepared: PreparedOther; priority: number; addressed: boolean; before: ReturnType<typeof readConflict> | null }>;
  /** The stem as placed at the scope's baseline, which every candidate is compared with. */
  placedBefore: Lrc[] | null;
}

/** Evidence turned into numbers once; a search reads the same evidence for every candidate. */
const compiledEvidence = new WeakMap<SpatialEvidence, CompiledScope[]>();

function compile(evidence: SpatialEvidence): CompiledScope[] {
  const cached = compiledEvidence.get(evidence);
  if (cached) return cached;
  const compiled = evidence.scopes.map((scope) => ({
    target: toLrc(scope.target),
    rest: toLrc(scope.rest),
    pairs: scope.pairs.map((pair) => {
      const input = { target: toLrc(pair.target), other: toLrc(pair.other), weights: pair.weights, frequency: pair.frequency, activity: pair.activity, mono: evidence.mono };
      return { input, prepared: prepareOther(input.other, input.weights), priority: pair.priority, addressed: pair.addressed, before: null };
    }),
    placedBefore: null,
  }));
  compiledEvidence.set(evidence, compiled);
  return compiled;
}

/**
 * Re-reads a row's effect from its stored evidence: the conflict with each related stem, the stem's own
 * correlation, mono fold-down, and center share, and the mix's center load, balance, and mono fold-down.
 * `before` uses each scope's baseline, `after` the row's values.
 */
export function evaluateSpatial(
  evidence: SpatialEvidence,
  processing: { pan: number | null; width: number | null },
  global: boolean,
): Omit<SpatialEvaluation, "passes" | "proxy"> {
  let conflictBefore = 0;
  let conflictAfter = 0;
  let collateral = 0;
  let overlapBefore = 0;
  let overlapAfter = 0;
  let overlapWeight = 0;
  const own = { before: { l: 0, r: 0, c: 0 }, after: { l: 0, r: 0, c: 0 } };
  let centerBefore = 0;
  let centerAfter = 0;
  let ownPower = 0;
  const mixBefore = mixAccumulator();
  const mixAfter = mixAccumulator();
  let levelBefore = 0;
  let levelAfter = 0;
  const compiled = compile(evidence);
  evidence.scopes.forEach((scope, index) => {
    const prepared = compiled[index]!;
    const baseline = scope.baseline;
    const after = settingInScope(scope, processing, global);
    const target = prepared.target;
    for (const pair of prepared.pairs) {
      pair.before ??= readConflict(pair.input, baseline, pair.prepared);
      const before = pair.before;
      const later = readConflict(pair.input, after, pair.prepared);
      if (!pair.addressed) {
        collateral += scope.weight * pair.priority * Math.max(0, later.severity - before.severity);
        continue;
      }
      conflictBefore += scope.weight * pair.priority * before.severity;
      conflictAfter += scope.weight * pair.priority * later.severity;
      overlapBefore += scope.weight * before.overlap;
      overlapAfter += scope.weight * later.overlap;
      overlapWeight += scope.weight;
    }
    prepared.placedBefore ??= target.map((stats) => placeStats(stats, baseline, evidence.mono));
    const placedBefore = prepared.placedBefore;
    const placedAfter = target.map((stats) => placeStats(stats, after, evidence.mono));
    const sumBefore = placedBefore.reduce((acc, value) => addLrc(acc, value), { l: 0, r: 0, c: 0 });
    const sumAfter = placedAfter.reduce((acc, value) => addLrc(acc, value), { l: 0, r: 0, c: 0 });
    own.before = addLrc(own.before, sumBefore, scope.weight);
    own.after = addLrc(own.after, sumAfter, scope.weight);
    const power = stereoPower(sumBefore);
    centerBefore += scope.weight * power * centerShareOf(placedBefore);
    centerAfter += scope.weight * power * centerShareOf(placedAfter);
    ownPower += scope.weight * power;
    levelBefore += scope.weight * stereoPower(sumBefore);
    levelAfter += scope.weight * stereoPower(sumAfter);
    addMix(mixBefore, scope, placedBefore);
    addMix(mixAfter, scope, placedAfter);
  });
  const imageBefore = imageOf(own.before);
  const imageAfter = imageOf(own.after);
  return {
    method: "stereo-statistics",
    conflictBefore: round3(conflictBefore),
    conflictAfter: round3(conflictAfter),
    collateral: round3(collateral),
    overlapBefore: round3(overlapWeight > 0 ? overlapBefore / overlapWeight : 0),
    overlapAfter: round3(overlapWeight > 0 ? overlapAfter / overlapWeight : 0),
    centerBefore: round3(ownPower > 0 ? centerBefore / ownPower : 0),
    centerAfter: round3(ownPower > 0 ? centerAfter / ownPower : 0),
    correlationBefore: round3(imageBefore.correlation),
    correlationAfter: round3(imageAfter.correlation),
    monoLossBeforeDb: round2(imageBefore.monoLossDb),
    monoLossAfterDb: round2(imageAfter.monoLossDb),
    mixBefore: finishMix(mixBefore),
    mixAfter: finishMix(mixAfter),
    levelChangeDb: round2(levelBefore > 0 && levelAfter > 0 ? 10 * Math.log10(levelAfter / levelBefore) : 0),
  };
}

function centerShareOf(placed: Lrc[]): number {
  let weighted = 0;
  let total = 0;
  for (const stats of placed) {
    const power = stereoPower(stats);
    if (power <= 0) continue;
    weighted += power * fieldShares(occupancy(imageOf(stats))).center;
    total += power;
  }
  return total > 0 ? weighted / total : 0;
}

interface MixAccumulator {
  centerPower: number;
  power: number;
  balance: number;
  sum: Lrc;
}

function mixAccumulator(): MixAccumulator {
  return { centerPower: 0, power: 0, balance: 0, sum: { l: 0, r: 0, c: 0 } };
}

function addMix(acc: MixAccumulator, scope: SpatialEvidence["scopes"][number], placed: Lrc[]): void {
  let scopeSum: Lrc = { l: 0, r: 0, c: 0 };
  let centerPower = 0;
  let power = 0;
  placed.forEach((stats, band) => {
    const rest = scope.rest[band]!;
    const merged = { l: stats.l + rest[0], r: stats.r + rest[1], c: stats.c + rest[2] };
    scopeSum = addLrc(scopeSum, merged);
    const ownPower = stereoPower(stats);
    centerPower += (scope.restCenter[band] ?? 0) + ownPower * fieldShares(occupancy(imageOf(stats))).center;
    power += stereoPower({ l: rest[0], r: rest[1], c: rest[2] }) + ownPower;
  });
  acc.centerPower += scope.weight * centerPower;
  acc.power += scope.weight * power;
  acc.sum = addLrc(acc.sum, scopeSum, scope.weight);
  const total = scopeSum.l + scopeSum.r;
  if (total > 0) acc.balance = Math.max(acc.balance, Math.abs(scopeSum.r - scopeSum.l) / total);
}

function finishMix(acc: MixAccumulator): MixMetrics {
  const image = imageOf(acc.sum);
  return {
    centerLoad: round3(acc.power > 0 ? Math.min(1, acc.centerPower / acc.power) : 0),
    balance: round3(Math.min(1, acc.balance)),
    correlation: round3(image.correlation),
    monoLossDb: round2(image.monoLossDb),
  };
}

/** Plain-language safety notes for a row's values. A note does not change the row's status; review does. */
export function safetyWarnings(
  change: Pick<SpatialRecommendation, "current" | "scope">,
  processing: { pan: number | null; width: number | null },
  evaluation: Omit<SpatialEvaluation, "passes" | "proxy">,
): string[] {
  const out: string[] = [];
  const widened = processing.width !== null && processing.width > change.current.width + 0.005;
  if (widened && evaluation.correlationAfter < CORRELATION_FLOOR) {
    out.push(`Correlation would drop to ${evaluation.correlationAfter.toFixed(2)}. Below ${CORRELATION_FLOOR.toFixed(1)} the stem starts to thin out in mono.`);
  }
  if (evaluation.monoLossAfterDb - evaluation.monoLossBeforeDb > MONO_LOSS_LIMIT_DB) {
    out.push(`Folded to mono, this stem would lose ${evaluation.monoLossAfterDb.toFixed(1)} dB against ${evaluation.monoLossBeforeDb.toFixed(1)} dB now.`);
  }
  if (evaluation.mixAfter.balance > MIX_BALANCE_LIMIT && evaluation.mixAfter.balance > evaluation.mixBefore.balance + 0.02) {
    out.push(`The mix would lean ${Math.round(evaluation.mixAfter.balance * 100)}% to one side where this stem plays.`);
  }
  if (processing.width !== null && (processing.width < AUTO_WIDTH_MIN - 0.005 || processing.width > AUTO_WIDTH_MAX + 0.005)) {
    out.push(`Width ${Math.round(processing.width * 100)}% is outside the ${Math.round(AUTO_WIDTH_MIN * 100)}–${Math.round(AUTO_WIDTH_MAX * 100)}% range Audiosous sets on its own.`);
  } else if (processing.pan !== null && (Math.abs(processing.pan) > AUTO_PAN_LIMIT + 0.005 || Math.abs(processing.pan - change.current.pan) > REVIEW_PAN_MOVE + 0.005)) {
    out.push(`A ${Math.round(Math.abs(processing.pan - change.current.pan) * 100)}% move to ${describePan(processing.pan)} is larger than Audiosous makes on its own.`);
  }
  return out.slice(0, 4);
}

/** Review is about the size and safety of the move, and the confidence behind it. */
export function needsReview(change: Pick<SpatialRecommendation, "current">, processing: { pan: number | null; width: number | null }, confidence: number, warnings: string[]): boolean {
  if (confidence < REVIEW_CONFIDENCE) return true;
  if (warnings.length > 0) return true;
  if (processing.pan !== null && Math.abs(processing.pan - change.current.pan) > REVIEW_PAN_MOVE + 0.005) return true;
  return false;
}

/**
 * Where a row's stem sits before and after, from its evidence: statistics summed over the scopes it affects,
 * weighted by how long it plays in each. For drawing the stereo field; an edit redraws without the planner.
 */
export function recommendationImages(change: Pick<SpatialRecommendation, "evidence" | "processing" | "scope">): { before: ImageDto; after: ImageDto } {
  const global = change.scope.type === "global";
  let before: Lrc = { l: 0, r: 0, c: 0 };
  let after: Lrc = { l: 0, r: 0, c: 0 };
  for (const scope of change.evidence.scopes) {
    const target = toLrc(scope.target);
    const settingAfter = settingInScope(scope, change.processing, global);
    for (const stats of target) {
      before = addLrc(before, placeStats(stats, scope.baseline, change.evidence.mono), scope.weight);
      after = addLrc(after, placeStats(stats, settingAfter, change.evidence.mono), scope.weight);
    }
  }
  return { before: imageDto(imageOf(before)), after: imageDto(imageOf(after)) };
}

/* ------------------------------------------------------------------ proxy check */

export interface SpatialProxyCheck {
  id: string;
  correlationBefore: number;
  correlationAfter: number;
  monoLossBeforeDb: number;
  monoLossAfterDb: number;
  peakBeforeDbfs: number;
  peakAfterDbfs: number;
  seconds: number;
}

/**
 * Folds the playback-proxy measurements into the plan. A row whose measured correlation or mono fold-down
 * moves the wrong way, or much further than predicted, goes to review with the numbers in its reasons.
 */
export function withSpatialProxyChecks(plan: SpatialPlan, checks: SpatialProxyCheck[], failed = 0): SpatialPlan {
  const byId = new Map(checks.map((check) => [check.id, check]));
  let disagreements = 0;
  const changes = plan.changes.map((change) => {
    const check = byId.get(change.id);
    if (!check || !change.evaluation) return change;
    const predictedCorr = change.evaluation.correlationAfter - change.evaluation.correlationBefore;
    const measuredCorr = check.correlationAfter - check.correlationBefore;
    const predictedLoss = change.evaluation.monoLossAfterDb - change.evaluation.monoLossBeforeDb;
    const measuredLoss = check.monoLossAfterDb - check.monoLossBeforeDb;
    const corrAgrees = Math.abs(measuredCorr - predictedCorr) <= Math.max(0.12, 0.5 * Math.abs(predictedCorr));
    const lossAgrees = Math.abs(measuredLoss - predictedLoss) <= Math.max(0.6, 0.5 * Math.abs(predictedLoss));
    const safe = check.monoLossAfterDb - check.monoLossBeforeDb <= MONO_LOSS_LIMIT_DB && !(change.processing.width !== null && change.processing.width > change.current.width && check.correlationAfter < CORRELATION_FLOOR);
    const agrees = corrAgrees && lossAgrees && safe;
    const evaluation = {
      ...change.evaluation,
      proxy: {
        correlationBefore: round3(check.correlationBefore),
        correlationAfter: round3(check.correlationAfter),
        monoLossBeforeDb: round2(check.monoLossBeforeDb),
        monoLossAfterDb: round2(check.monoLossAfterDb),
        peakChangeDb: round2(check.peakAfterDbfs - check.peakBeforeDbfs),
        seconds: Math.round(check.seconds * 10) / 10,
        agrees,
      },
    };
    if (agrees) return { ...change, evaluation };
    disagreements += 1;
    const reason = `On the playback proxy (${evaluation.proxy.seconds.toFixed(1)} s) correlation went ${check.correlationBefore.toFixed(2)} → ${check.correlationAfter.toFixed(2)} and the mono fold-down loss ${check.monoLossBeforeDb.toFixed(1)} → ${check.monoLossAfterDb.toFixed(1)} dB, against a prediction of ${change.evaluation.correlationBefore.toFixed(2)} → ${change.evaluation.correlationAfter.toFixed(2)} and ${change.evaluation.monoLossBeforeDb.toFixed(1)} → ${change.evaluation.monoLossAfterDb.toFixed(1)} dB, so it waits for a listen.`;
    const confidence = Math.max(0.2, Math.round((change.confidence - 0.1) * 100) / 100);
    return {
      ...change,
      evaluation,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      status: change.status === "proposed" ? ("needs-review" as const) : change.status,
      reasons: [...change.reasons.slice(0, 5), reason.slice(0, 600)],
    };
  });
  const notes = plan.summary.notes.filter((note) => !note.startsWith("Proxy check:"));
  const checked = checks.filter((check) => plan.changes.some((change) => change.id === check.id)).length;
  if (checked > 0 || failed > 0) {
    notes.push(
      `Proxy check: ${checked} ${checked === 1 ? "row was" : "rows were"} run through the native width and pan stage on the 48 kHz playback proxies; ${checked - disagreements} matched the prediction${disagreements > 0 ? `, ${disagreements} went to review` : ""}${failed > 0 ? `, ${failed} could not be checked` : ""}.`,
    );
  }
  const reviewCount = changes.filter((change) => change.status === "needs-review").length;
  return refreshSpatialTrim({ ...plan, changes, summary: { ...plan.summary, notes: notes.slice(-10), reviewCount } });
}

/* ------------------------------------------------------------------ audition, apply */

export interface SpatialAuditionOptions {
  mode: "current" | "candidate";
  focusId?: string | null;
  focusSide?: "bypassed" | "recommended";
}

export interface SpatialAudition {
  tracks: Array<{ trackId: string; pan: number; width: number }>;
  /** Section windows with the pan and width in effect there. Only sections whose values differ from the track's. */
  regions: Array<{ trackId: string; sectionId: string; startSeconds: number; endSeconds: number; pan: number; width: number }>;
  trimDb: number;
  note: string;
}

/**
 * Saved spatial state plus the included candidate rows. The saved project is not touched.
 * Single-row audition plays the whole mix with only that row switched.
 */
export function spatialAudition(document: ProjectDocument, plan: SpatialPlan | null, options: SpatialAuditionOptions): SpatialAudition {
  const focusId = options.focusId ?? null;
  const focusSide = options.focusSide ?? "recommended";
  const chosen = (plan?.changes ?? []).filter((change) => {
    if (focusId === change.id) return focusSide === "recommended";
    if (options.mode === "current") return false;
    return spatialRecommendationIncluded(change, "preview");
  });
  const candidate = chosen.length > 0 ? applyRows(document, chosen) : document;
  const tracks = candidate.tracks.map((track) => ({ trackId: track.id, pan: track.pan, width: track.width }));
  const regions: SpatialAudition["regions"] = [];
  for (const row of candidate.sectionTrackSettings) {
    if (row.overrides.pan === null && row.overrides.width === null) continue;
    const section = candidate.sections.find((item) => item.id === row.sectionId);
    const track = candidate.tracks.find((item) => item.id === row.trackId);
    if (!section || !track) continue;
    regions.push({
      trackId: row.trackId,
      sectionId: row.sectionId,
      startSeconds: section.startTime,
      endSeconds: section.endTime,
      pan: row.overrides.pan ?? track.pan,
      width: row.overrides.width ?? track.width,
    });
  }
  const included = new Set(chosen.map((change) => change.id));
  const trimDb = plan && options.mode === "candidate" && !focusId ? trimFor(plan, included) : 0;
  return { tracks, regions, trimDb, note: auditionNote(options, trimDb) };
}

/** Pan and width a native-less engine should play for one track at `seconds`. */
export function spatialAuditionAt(audition: SpatialAudition, trackId: string, seconds: number): { pan: number; width: number } {
  const region = audition.regions.find((item) => item.trackId === trackId && seconds >= item.startSeconds && seconds < item.endSeconds);
  if (region) return { pan: region.pan, width: region.width };
  const own = audition.tracks.find((item) => item.trackId === trackId);
  return own ? { pan: own.pan, width: own.width } : { pan: 0, width: 1 };
}

/** Writes the chosen rows into track pan/width and Track × Section overrides. One call is one undo step for the caller. */
export function applySpacePlan(document: ProjectDocument, plan: SpatialPlan, mode: SpatialApplyMode): ProjectDocument {
  const chosen = plan.changes.filter((change) => (mode === "accepted" ? change.status === "accepted" : spatialRecommendationIncluded(change, "all")));
  let next = applyRows(document, chosen);
  const trim = trimFor(plan, new Set(chosen.map((change) => change.id)));
  if (Math.abs(trim) >= 0.05) {
    next = {
      ...next,
      tracks: next.tracks.map((track) => ({ ...track, gainDb: clampGain(track.gainDb + trim) })),
      sectionTrackSettings: next.sectionTrackSettings
        .map((row) => (row.overrides.gainDb === null ? row : { ...row, overrides: { ...row.overrides, gainDb: clampGain(row.overrides.gainDb + trim) } }))
        .filter(sectionSettingInUse),
    };
  }
  return withUpdatedAt(next);
}

/** Whole-song rows first, then section rows, so a section override is read against the new track value. */
function applyRows(document: ProjectDocument, rows: SpatialRecommendation[]): ProjectDocument {
  let next = document;
  const ordered = [...rows].sort((left, right) => (left.scope.type === "global" ? 0 : 1) - (right.scope.type === "global" ? 0 : 1));
  for (const change of ordered) {
    const patch: { pan?: number; width?: number } = {};
    if (change.processing.pan !== null) patch.pan = change.processing.pan;
    if (change.processing.width !== null) patch.width = change.processing.width;
    const result = change.scope.type === "global" ? setTrackSpatial(next, change.trackId, patch) : setSectionSpatial(next, change.trackId, change.scope.sectionId, patch);
    if (result.ok) next = result.document;
  }
  return next;
}

/* ------------------------------------------------------------------ headroom */

/**
 * Pan moves energy between channels and widening raises the side signal, so a peak can rise even when no
 * gain moves. Each channel gets its own power-sum estimate from each stem's cached peak and its
 * statistics under the current and the candidate pan and width. If the candidate's louder channel would be
 * hotter than now or than −1 dBFS, a uniform trim (up to −6 dB) keeps the relative balance. It is an
 * estimate, not a rendered true-peak pass, and not a limiter.
 */
export function refreshSpatialTrim(plan: SpatialPlan): SpatialPlan {
  const included = new Set(plan.changes.filter((change) => spatialRecommendationIncluded(change, "preview")).map((change) => change.id));
  const trim = trimFor(plan, included);
  const reason =
    Math.abs(trim) < 0.05
      ? null
      : `Headroom trim: ${formatSignedDb(trim)} dB on every stem because the candidate pan and width could push the estimated peak of one channel past the current mix or -1 dBFS. This is a safety trim, not a spatial decision, and it keeps the relative balance.`;
  const notes = plan.summary.notes.filter((note) => !note.startsWith("Headroom trim:"));
  if (reason) notes.push(reason);
  return { ...plan, candidateTrim: { gainDb: trim, reason }, summary: { ...plan.summary, notes: notes.slice(-10) } };
}

function trimFor(plan: SpatialPlan, included: Set<string>): number {
  const chosen = plan.changes.filter((change) => included.has(change.id) && change.scope.type === "global");
  const sections = plan.changes.filter((change) => included.has(change.id) && change.scope.type === "section");
  const channels = (pick: (level: SpatialPlan["levels"][number]) => SpatialSetting[]) => {
    const left: Array<{ peakDbfs: number | null; gainDb: number; muted: boolean }> = [];
    const right: typeof left = [];
    for (const level of plan.levels) {
      const stats = { l: level.stats[0], r: level.stats[1], c: level.stats[2] };
      const loudest = Math.max(stats.l, stats.r);
      // The loudest channel lift any of the track's settings reaches.
      let liftLeft = -Infinity;
      let liftRight = -Infinity;
      for (const setting of pick(level)) {
        const placed = placeStats(stats, setting, level.mono);
        liftLeft = Math.max(liftLeft, loudest > 0 ? 10 * Math.log10(Math.max(placed.l, 1e-20) / loudest) : 20 * Math.log10(equalPowerPan(setting.pan)[0]));
        liftRight = Math.max(liftRight, loudest > 0 ? 10 * Math.log10(Math.max(placed.r, 1e-20) / loudest) : 20 * Math.log10(equalPowerPan(setting.pan)[1]));
      }
      left.push({ peakDbfs: level.peakDbfs === null ? null : level.peakDbfs + liftLeft, gainDb: level.gainDb, muted: level.muted });
      right.push({ peakDbfs: level.peakDbfs === null ? null : level.peakDbfs + liftRight, gainDb: level.gainDb, muted: level.muted });
    }
    const estimates = [estimateSumPeakDbfs(left), estimateSumPeakDbfs(right)].filter((value): value is number => value !== null);
    return estimates.length > 0 ? Math.max(...estimates) : null;
  };
  const current = channels((level) => [level.current]);
  const candidate = channels((level) => {
    const global = chosen.find((change) => change.trackId === level.trackId);
    const base = { pan: global?.processing.pan ?? level.current.pan, width: global?.processing.width ?? level.current.width };
    const settings = [base];
    for (const change of sections.filter((item) => item.trackId === level.trackId)) {
      settings.push({ pan: change.processing.pan ?? base.pan, width: change.processing.width ?? base.width });
    }
    return settings;
  });
  if (current === null || candidate === null) return 0;
  return headroomTrimDb(current, candidate);
}

function auditionNote(options: SpatialAuditionOptions, trim: number): string {
  if (options.focusId) return "Single-row audition plays the whole mix. Only this row's pan and width are switched, so the difference you hear is that row.";
  if (options.mode === "current") return "Current plays the saved mix with its saved pan and width.";
  if (Math.abs(trim) < 0.05) return "Spatial Candidate plays the saved mix with the included pan and width changes. No loudness match is applied.";
  return `Spatial Candidate includes a ${formatSignedDb(trim)} dB safety trim on every stem for headroom. It is not part of any spatial move.`;
}

/* ------------------------------------------------------------------ formatting */

/** "center", "18% right", "30% left". */
export function describePan(pan: number): string {
  const value = Math.round(pan * 100);
  if (value === 0) return "center";
  return value < 0 ? `${Math.abs(value)}% left` : `${value}% right`;
}

export function describeWidth(width: number): string {
  return `${Math.round(width * 100)}%`;
}

export function imageDto(image: ReturnType<typeof imageOf>): ImageDto {
  return {
    position: round3(Math.max(-1, Math.min(1, image.position))),
    spread: round3(Math.max(0, Math.min(1, image.spread))),
    correlation: round3(Math.max(-1, Math.min(1, image.correlation))),
    sideShare: round3(Math.max(0, Math.min(1, image.sideShare))),
    monoLossDb: round2(Math.max(0, Math.min(40, image.monoLossDb))),
    msRatioDb: round2(image.msRatioDb),
  };
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clampGain(value: number): number {
  return Math.round(Math.min(GAIN_DB_MAX, Math.max(GAIN_DB_MIN, value)) * 10) / 10;
}

/** Rounded, with −0 folded into 0 so a plan survives a JSON round trip unchanged. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100 || 0;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000 || 0;
}
