import { ANALYSIS_ENGINE_VERSION, ENVELOPE_FRAMES_VERSION, EQ_BANDS_VERSION, decodeEnvelopeSeries } from "@audiosous/analysis-contract";
import { confidenceLabel, formatSignedDb, type SourceFingerprint } from "@audiosous/balance-planner";
import { filterMagnitudeDb, maskCurve } from "@audiosous/eq-planner";
import {
  DYNAMICS_LIMITS,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  dynamicsIdentity,
  dynamicsNodeRunnable,
  normalizeDynamicsNode,
  orderDynamics,
  processingIdentity,
  sectionDynamicsNodes,
  setSectionDynamicsNodes,
  setTrackDynamicsNodes,
  spatialIdentity,
  trackDynamicsNodes,
  withUpdatedAt,
  type DynamicsNode,
  type ProjectDocument,
} from "@audiosous/project-model";
import { z } from "zod";
import { CELL_FRAMES, HOP_SECONDS, percentile, spreadOf, sustainedLevels } from "./envelope";
import {
  AUTO_RANGES,
  DYNAMICS_PLAN_VERSION,
  DYNAMICS_PLANNER_VERSION,
  DYNAMICS_STRENGTHS,
  REVIEW_CONFIDENCE,
  REVIEW_DUCK_DB,
  REVIEW_DYNAMIC_EQ_DB,
  REVIEW_GR_DB,
  REVIEW_TRANSIENT,
  SWING_DB,
  type DynamicsSettings,
} from "./settings";
import { downsampleMax, simulateCompressor, simulateDucking, simulateDynamicEq, transientGainDb } from "./simulate";

const finite = z.number().finite();
const L = DYNAMICS_LIMITS;

const scopeSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("global") }), z.object({ type: z.literal("section"), sectionId: z.string().min(1) })]);
export type DynamicsScope = z.infer<typeof scopeSchema>;

const threshold = finite.min(L.minThresholdDb).max(L.maxThresholdDb);
const attack = finite.min(L.minAttackMs).max(L.maxAttackMs);
const release = finite.min(L.minReleaseMs).max(L.maxReleaseMs);
const range = finite.min(L.minRangeDb).max(L.maxRangeDb);

const compressorProcessing = z.object({
  type: z.literal("compressor"),
  thresholdDb: threshold,
  ratio: finite.min(L.minRatio).max(L.maxRatio),
  attackMs: attack,
  releaseMs: release,
  kneeDb: finite.min(L.minKneeDb).max(L.maxKneeDb),
  makeupDb: finite.min(L.minMakeupDb).max(L.maxMakeupDb),
});
const duckingProcessing = z.object({
  type: z.literal("ducking"),
  keyTrackId: z.string().min(1),
  keyDetector: z.enum(["transient", "smooth"]),
  thresholdDb: threshold,
  rangeDb: range,
  attackMs: attack,
  releaseMs: release,
});
const transientProcessing = z.object({
  type: z.literal("transient"),
  attack: finite.min(-L.maxTransientAttack).max(L.maxTransientAttack),
  sustain: finite.min(-L.maxTransientSustain).max(L.maxTransientSustain),
});
const dynamicEqProcessing = z.object({
  type: z.literal("dynamic-eq"),
  filter: z.object({ kind: z.literal("bell"), frequencyHz: finite.min(L.minHz).max(L.maxHz), q: finite.min(L.minQ).max(L.maxQ) }),
  keyTrackId: z.string().min(1).nullable(),
  keyDetector: z.enum(["transient", "smooth"]),
  thresholdDb: threshold,
  rangeDb: range,
  attackMs: attack,
  releaseMs: release,
});

export const dynamicsProcessingSchema = z.discriminatedUnion("type", [compressorProcessing, duckingProcessing, transientProcessing, dynamicEqProcessing]);
export type DynamicsProcessing = z.infer<typeof dynamicsProcessingSchema>;
export type CompressorProcessing = z.infer<typeof compressorProcessing>;
export type DuckingProcessing = z.infer<typeof duckingProcessing>;
export type TransientProcessing = z.infer<typeof transientProcessing>;
export type DynamicEqProcessing = z.infer<typeof dynamicEqProcessing>;

const segmentOffset = z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), db: finite });

/**
 * What a recommendation was judged on, so an edit can be re-checked without the planner or the audio.
 * Level series are base64 envelope series (dB per 10 ms frame, 0.5 dB steps), relative to `start`.
 */
const levelEvidence = z.object({
  kind: z.literal("level"),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  /** Compressor detector input: the stem's RMS after its EQ, before the fader and before this node. */
  detector: z.string(),
  /** 10 ms peak of the same signal. */
  peak: z.string(),
  /** The raw RMS that decides which cells play. */
  reference: z.string(),
  loudestCellDb: finite,
  /** Fader or section gain over the frames, so a whole-song spread includes the section gains. */
  offsets: z.array(segmentOffset).max(64),
  /** A saved compressor this row replaces, simulated for "before". */
  existing: compressorProcessing.nullable(),
});

const collisionEvidence = z.object({
  kind: z.literal("collision"),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  /** The key track's raw peak and RMS (the key is read before its EQ, dynamics, and fader). */
  keyPeak: z.string(),
  keyRms: z.string(),
  /** Low band (< 150 Hz) of key and target as heard; the target before this node and any duck it replaces. */
  keyLow: z.string(),
  targetLow: z.string(),
  targetRms: z.string(),
  /** Key onsets where the target plays, frames relative to `start`. */
  onsets: z.array(z.number().int().nonnegative()).max(4_000),
  existing: duckingProcessing.nullable(),
});

const maskingEvidence = z.object({
  kind: z.literal("masking"),
  stepSeconds: finite.positive(),
  edgesHz: z.array(finite.positive()).length(25),
  /** Steps of the planner's time grid where the target plays, in order. */
  steps: z.array(z.number().int().nonnegative()).max(400),
  /** Whether the protected (key) stem plays at each of those steps. */
  keyActive: z.array(z.boolean()).max(400),
  /** Per step and grid band, dB: the key stem raw (its detector), and the target and protected stems as heard. */
  keyBands: z.array(z.array(finite).length(24)).max(400),
  targetBands: z.array(z.array(finite).length(24)).max(400),
  protectedBands: z.array(z.array(finite).length(24)).max(400),
  /** The protected stem's role weights per band: which frequencies define it. */
  weights: z.array(finite.min(0)).length(24),
  existing: z.union([dynamicEqProcessing, duckingProcessing]).nullable(),
});

const transientEvidence = z.object({
  kind: z.literal("transient"),
  /** Each onset as heard: attack and body energy (dB), its rise, and the rest of the mix at the attack. */
  onsets: z
    .array(z.object({ frame: z.number().int().nonnegative(), attackDb: finite, bodyDb: finite, riseDb: finite, mixDb: finite }))
    .max(4_000),
  /** Power mean of the stem where it plays, dB, and how many frames that is. */
  levelDb: finite,
  frames: z.number().int().nonnegative(),
  existing: transientProcessing.nullable(),
});

const evidenceSchema = z.object({
  detail: z.discriminatedUnion("kind", [levelEvidence, collisionEvidence, maskingEvidence, transientEvidence]),
  /** Where the problem happens, seconds, for checking on the playback proxy. */
  windows: z.array(z.tuple([finite.nonnegative(), finite.nonnegative()])).max(24),
  /** Conflict band for keyed checks, Hz. */
  band: z.tuple([finite.positive(), finite.positive()]).nullable(),
});

export type DynamicsEvidence = z.infer<typeof evidenceSchema>;
export type LevelEvidence = z.infer<typeof levelEvidence>;
export type CollisionEvidence = z.infer<typeof collisionEvidence>;
export type MaskingEvidence = z.infer<typeof maskingEvidence>;
export type TransientEvidence = z.infer<typeof transientEvidence>;

const nullableDb = finite.nullable();

export const dynamicsEvaluationSchema = z.object({
  method: z.literal("envelope-simulation"),
  /** Reduction this row applies: compressor over the frames the stem plays, duck during the key's hits or phrases, dynamic EQ dip while its key plays. */
  reductionP50Db: finite,
  reductionP95Db: finite,
  reductionMaxDb: finite,
  /** Average change of the stem's level where it plays (negative is quieter). */
  levelChangeDb: finite,
  /** Sustained-level spread (p90 − p10 of 400 ms windows), compressor rows. */
  spreadBeforeDb: nullableDb,
  spreadAfterDb: nullableDb,
  /** Loudest 10 ms peak minus the average level, compressor rows. */
  crestBeforeDb: nullableDb,
  crestAfterDb: nullableDb,
  peakChangeDb: nullableDb,
  /** Keyed rows: how far the target sits over the protected/key stem where they meet (dB, lower is better). */
  conflictBeforeDb: nullableDb,
  conflictAfterDb: nullableDb,
  /** Kick/bass: share of hits where the bass's low end is within 3 dB of the kick's. Masking: masked share. */
  collisionBefore: finite.min(0).max(1).nullable(),
  collisionAfter: finite.min(0).max(1).nullable(),
  /** Keyed rows: change of the target where the key is not playing (the price of the move). */
  outsideChangeDb: nullableDb,
  /** Ducks: share of the time between hits the target is back within 0.5 dB. */
  recovery: finite.min(0).max(1).nullable(),
  /** Transient rows: median attack minus body, and the attack over the rest of the mix. */
  transientBeforeDb: nullableDb,
  transientAfterDb: nullableDb,
  attackOverMixBeforeDb: nullableDb,
  attackOverMixAfterDb: nullableDb,
  /** Reduction over the scope for drawing: largest value per bucket. */
  timeline: z.object({ startSeconds: finite.nonnegative(), hopSeconds: finite.positive(), values: z.array(finite).max(400) }),
  passes: z.number().int().min(0).max(2),
  proxy: z
    .object({
      reductionP50Db: finite,
      reductionP95Db: finite,
      reductionMaxDb: finite,
      levelChangeDb: finite,
      spreadBeforeDb: nullableDb,
      spreadAfterDb: nullableDb,
      transientBeforeDb: nullableDb,
      transientAfterDb: nullableDb,
      bandOnChangeDb: nullableDb,
      bandOffChangeDb: nullableDb,
      recovered: finite.min(0).max(1).nullable(),
      seconds: finite.nonnegative(),
      agrees: z.boolean(),
    })
    .nullable(),
});

export type DynamicsEvaluation = z.infer<typeof dynamicsEvaluationSchema>;
type Evaluated = Omit<DynamicsEvaluation, "passes" | "proxy">;

export const DYNAMICS_PROBLEMS = ["level-inconsistency", "transient-excess", "transient-weakness", "low-end-collision", "event-masking"] as const;
export type DynamicsProblem = (typeof DYNAMICS_PROBLEMS)[number];

export const dynamicsRecommendationSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  scope: scopeSchema,
  problem: z.enum(DYNAMICS_PROBLEMS),
  processing: dynamicsProcessingSchema,
  /** As planned, so an edit can be compared and reset. */
  planned: dynamicsProcessingSchema,
  /** A saved node this row edits instead of adding another. */
  replacesNodeId: z.string().nullable(),
  /** What the compressor should do, in result terms: reduction on the loudest sustained passages. */
  targetReductionDb: z.object({ min: finite, max: finite }).nullable(),
  relatedTrackIds: z.array(z.string()).max(4),
  interactionIds: z.array(z.string()).max(8),
  confidence: finite.min(0).max(1),
  confidenceLabel: z.enum(["high", "medium", "low"]),
  status: z.enum(["proposed", "accepted", "rejected", "needs-review"]),
  edited: z.boolean(),
  reasons: z.array(z.string().min(1).max(600)).min(1).max(6),
  warnings: z.array(z.string().max(300)).max(4),
  evaluation: dynamicsEvaluationSchema.nullable(),
  evidence: evidenceSchema,
});

export type DynamicsRecommendation = z.infer<typeof dynamicsRecommendationSchema>;

/** One time-domain relationship between two stems, usable by later planning without the plan's rows. */
export const dynamicsInteractionSchema = z.object({
  id: z.string().min(1),
  scope: scopeSchema,
  scopeName: z.string(),
  /** The stem that triggers (kick, lead) and the one that would give way. */
  trackA: z.string().min(1),
  trackB: z.string().min(1),
  kind: z.enum(["low-end", "event-masking", "sustained-masking"]),
  /** Share of A's hits or phrases while B plays. */
  onsetOverlap: finite.min(0).max(1),
  /** Kick/bass: share of hits where B's low end is within 3 dB of A's. */
  lowBandCompetition: finite.min(0).max(1),
  /** Masking severity of B on A while both play (EQ planner's measure, on the mix as heard). */
  levelMasking: finite.min(0).max(1),
  /** Share of B's playing time A is silent: what a static move would cost B. */
  freeShare: finite.min(0).max(1),
  recommendedTool: z.enum(["ducking", "dynamic-eq", "static-eq", "none"]),
  confidence: finite.min(0).max(1),
  outcome: z.enum(["recommendation", "review", "below-threshold", "already-separated", "static", "solved", "limit", "no-benefit"]),
  explanation: z.string().min(1).max(600),
});

export type DynamicsInteraction = z.infer<typeof dynamicsInteractionSchema>;

/** Per stem and scope: the measured dynamics and what they were classified as. */
export const dynamicsReadingSchema = z.object({
  trackId: z.string().min(1),
  scope: scopeSchema,
  scopeName: z.string(),
  spreadDb: nullableDb,
  swingRate: finite.min(0).max(1).nullable(),
  transientDb: nullableDb,
  attackOverMixDb: nullableDb,
  onsetsPerSecond: finite.nonnegative(),
  classification: z.enum(["steady", "phrased", "level-inconsistency", "transient-excess", "transient-weakness", "unmeasured"]),
  explanation: z.string().max(400),
});

export type DynamicsReading = z.infer<typeof dynamicsReadingSchema>;

export const dynamicsPlanSchema = z.object({
  planVersion: z.literal(DYNAMICS_PLAN_VERSION),
  plannerVersion: z.literal(DYNAMICS_PLANNER_VERSION),
  kind: z.literal("dynamics-balance"),
  createdAt: z.string().min(1),
  projectId: z.string().min(1),
  sourceAnalysisVersion: z.string().min(1),
  settings: z.object({ strength: z.enum(DYNAMICS_STRENGTHS) }),
  stateIdentity: z.string().min(1),
  summary: z.object({
    goal: z.literal("dynamics"),
    confidence: finite.min(0).max(1),
    headline: z.string().min(1),
    notes: z.array(z.string()).max(12),
    changeCount: z.number().int().nonnegative(),
    reviewCount: z.number().int().nonnegative(),
    tracksAnalyzed: z.number().int().nonnegative(),
    pairsAnalyzed: z.number().int().nonnegative(),
    analysisSource: z.string(),
  }),
  changes: z.array(dynamicsRecommendationSchema).max(64),
  interactions: z.array(dynamicsInteractionSchema).max(48),
  readings: z.array(dynamicsReadingSchema).max(400),
});

export type DynamicsPlan = z.infer<typeof dynamicsPlanSchema>;

/* ------------------------------------------------------------------ identity */

export function dynamicsPlanStateIdentity(document: ProjectDocument, settings: DynamicsSettings, fingerprints: SourceFingerprint[] = []): string {
  const files = new Map(fingerprints.map((file) => [file.trackId, file]));
  const payload = {
    projectId: document.project.id,
    analysis: [ANALYSIS_ENGINE_VERSION, EQ_BANDS_VERSION, ENVELOPE_FRAMES_VERSION],
    planner: DYNAMICS_PLANNER_VERSION,
    settings,
    tracks: document.tracks.map((track) => {
      const file = files.get(track.id);
      return [track.id, track.name, track.customLabel, track.role, track.gainDb, track.muted, track.metadata.durationSeconds, file?.fileSizeBytes ?? track.metadata.fileSizeBytes, file?.modifiedAtNs ?? ""];
    }),
    sections: document.sections.map((section) => [section.id, section.startTime, section.endTime, section.type, section.userIntent]),
    rows: [...document.sectionTrackSettings]
      .sort((left, right) => `${left.trackId}:${left.sectionId}`.localeCompare(`${right.trackId}:${right.sectionId}`))
      .map((row) => [row.trackId, row.sectionId, row.prominence, row.userIntent, row.overrides.gainDb]),
    eq: processingIdentity(document),
    spatial: spatialIdentity(document),
    dynamics: dynamicsIdentity(document),
  };
  return fnv1a(JSON.stringify(payload));
}

export function dynamicsPlanIsStale(plan: DynamicsPlan, document: ProjectDocument, fingerprints: SourceFingerprint[] = [], settings: DynamicsSettings = plan.settings): boolean {
  return plan.projectId !== document.project.id || plan.stateIdentity !== dynamicsPlanStateIdentity(document, settings, fingerprints);
}

/* ------------------------------------------------------------------ status, edit */

export type DynamicsApplyMode = "all" | "accepted";

export function dynamicsRecommendationIncluded(change: Pick<DynamicsRecommendation, "status">, mode: DynamicsApplyMode | "preview"): boolean {
  if (change.status === "rejected") return false;
  if (mode === "accepted") return change.status === "accepted";
  if (change.status === "needs-review") return false;
  return change.status === "proposed" || change.status === "accepted";
}

export function dynamicsRecommendationId(trackId: string, scope: DynamicsScope, type: DynamicsProcessing["type"], key: string | null): string {
  return `${trackId}::${scope.type === "global" ? "global" : `section::${scope.sectionId}`}::${type}${key ? `::${key}` : ""}`;
}

export function setDynamicsRecommendationStatus(plan: DynamicsPlan, id: string, status: DynamicsRecommendation["status"]): DynamicsPlan {
  return refreshCounts({ ...plan, changes: plan.changes.map((change) => (change.id === id ? { ...change, status } : change)) });
}

/** A partial edit of one row's processing. The type and the key track cannot be changed into another kind. */
export type DynamicsPatch = Partial<Omit<CompressorProcessing, "type">> &
  Partial<Omit<DuckingProcessing, "type" | "keyTrackId">> &
  Partial<Omit<TransientProcessing, "type">> &
  Partial<Omit<DynamicEqProcessing, "type" | "filter" | "keyTrackId">> & { frequencyHz?: number; q?: number; keyTrackId?: string | null };

/** Clamps a processing value to the stored bounds and rounds it the way the editor shows it. */
export function normalizeProcessing(processing: DynamicsProcessing): DynamicsProcessing {
  const node = normalizeDynamicsNode({ ...processing, id: "x", enabled: true, origin: "dynamics-plan", note: null } as DynamicsNode);
  const { id: _id, enabled: _enabled, origin: _origin, note: _note, ...rest } = node;
  return rest as DynamicsProcessing;
}

/**
 * Applies an edit to one recommendation and re-checks it from its stored evidence. The planner does not run
 * again and no audio is read. An edit that leaves Audiosous's automatic range goes to review.
 */
export function editDynamicsRecommendation(plan: DynamicsPlan, id: string, patch: DynamicsPatch): DynamicsPlan {
  const changes = plan.changes.map((change) => {
    if (change.id !== id) return change;
    const merged = mergePatch(change.processing, patch);
    const processing = normalizeProcessing(merged);
    const edited = JSON.stringify(processing) !== JSON.stringify(change.planned);
    // The proxy measurement stays: it describes the planned values, and the review panel says so once the row is edited.
    const evaluation = change.evaluation ? { ...evaluateDynamics(change.evidence, processing, change.scope), passes: change.evaluation.passes, proxy: change.evaluation.proxy } : null;
    const warnings = evaluation ? dynamicsWarnings(change, processing, evaluation) : [];
    const status = change.status === "proposed" && warnings.length > 0 ? ("needs-review" as const) : change.status;
    return { ...change, processing, edited, evaluation, warnings, status };
  });
  return refreshCounts({ ...plan, changes });
}

export function resetDynamicsRecommendation(plan: DynamicsPlan, id: string): DynamicsPlan {
  const change = plan.changes.find((item) => item.id === id);
  if (!change) return plan;
  const { type: _type, ...values } = change.planned as DynamicsProcessing & { filter?: { frequencyHz: number; q: number } };
  const patch: DynamicsPatch = { ...(values as DynamicsPatch) };
  if (change.planned.type === "dynamic-eq") {
    patch.frequencyHz = change.planned.filter.frequencyHz;
    patch.q = change.planned.filter.q;
  }
  return editDynamicsRecommendation(plan, id, patch);
}

function mergePatch(processing: DynamicsProcessing, patch: DynamicsPatch): DynamicsProcessing {
  const pick = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
  switch (processing.type) {
    case "compressor":
      return {
        type: "compressor",
        thresholdDb: pick(patch.thresholdDb, processing.thresholdDb),
        ratio: pick(patch.ratio, processing.ratio),
        attackMs: pick(patch.attackMs, processing.attackMs),
        releaseMs: pick(patch.releaseMs, processing.releaseMs),
        kneeDb: pick(patch.kneeDb, processing.kneeDb),
        makeupDb: pick(patch.makeupDb, processing.makeupDb),
      };
    case "ducking":
      return {
        type: "ducking",
        keyTrackId: pick(patch.keyTrackId ?? undefined, processing.keyTrackId),
        keyDetector: pick(patch.keyDetector, processing.keyDetector),
        thresholdDb: pick(patch.thresholdDb, processing.thresholdDb),
        rangeDb: pick(patch.rangeDb, processing.rangeDb),
        attackMs: pick(patch.attackMs, processing.attackMs),
        releaseMs: pick(patch.releaseMs, processing.releaseMs),
      };
    case "transient":
      return { type: "transient", attack: pick(patch.attack, processing.attack), sustain: pick(patch.sustain, processing.sustain) };
    case "dynamic-eq":
      return {
        type: "dynamic-eq",
        filter: { kind: "bell", frequencyHz: pick(patch.frequencyHz, processing.filter.frequencyHz), q: pick(patch.q, processing.filter.q) },
        keyTrackId: patch.keyTrackId === undefined ? processing.keyTrackId : patch.keyTrackId,
        keyDetector: pick(patch.keyDetector, processing.keyDetector),
        thresholdDb: pick(patch.thresholdDb, processing.thresholdDb),
        rangeDb: pick(patch.rangeDb, processing.rangeDb),
        attackMs: pick(patch.attackMs, processing.attackMs),
        releaseMs: pick(patch.releaseMs, processing.releaseMs),
      };
  }
}

/** Plain-language notes on values outside Audiosous's automatic range. A note sends an edit to review. */
export function dynamicsWarnings(change: Pick<DynamicsRecommendation, "targetReductionDb">, processing: DynamicsProcessing, evaluation: Evaluated): string[] {
  const out: string[] = [];
  const timing = (attackMs: number, releaseMs: number) => {
    if (attackMs < AUTO_RANGES.minAttackMs) out.push(`A ${attackMs} ms attack flattens every transient it catches; Audiosous stays at ${AUTO_RANGES.minAttackMs} ms or slower on its own.`);
    if (releaseMs < AUTO_RANGES.minReleaseMs || releaseMs > AUTO_RANGES.maxReleaseMs) out.push(`A ${releaseMs} ms release is outside the ${AUTO_RANGES.minReleaseMs}–${AUTO_RANGES.maxReleaseMs} ms Audiosous uses; it can pump or hold the stem down.`);
  };
  switch (processing.type) {
    case "compressor":
      if (processing.ratio > AUTO_RANGES.maxRatio) out.push(`Ratio ${processing.ratio.toFixed(1)}:1 is past the ${AUTO_RANGES.maxRatio}:1 Audiosous sets on its own.`);
      if (processing.makeupDb > 0) out.push(`Makeup gain (+${processing.makeupDb.toFixed(1)} dB) makes the compressed stem louder, which biases a comparison toward it.`);
      if (evaluation.reductionP95Db > REVIEW_GR_DB) out.push(`About ${evaluation.reductionP95Db.toFixed(1)} dB of reduction on the loudest passages is heavy compression.`);
      else if (change.targetReductionDb && evaluation.reductionP95Db > change.targetReductionDb.max + 1.5)
        out.push(`It reduces the loudest passages by ${evaluation.reductionP95Db.toFixed(1)} dB, well past the ${change.targetReductionDb.min}–${change.targetReductionDb.max} dB target.`);
      timing(processing.attackMs, processing.releaseMs);
      break;
    case "ducking":
      if (-processing.rangeDb > REVIEW_DUCK_DB) out.push(`A ${(-processing.rangeDb).toFixed(1)} dB duck is audible as an effect, not just separation.`);
      if (evaluation.recovery !== null && evaluation.recovery < 0.5) out.push(`The target is back to full level only ${Math.round(evaluation.recovery * 100)}% of the time between hits; it may sound held down or pumping.`);
      timing(processing.attackMs, processing.releaseMs);
      break;
    case "dynamic-eq":
      if (-processing.rangeDb > REVIEW_DYNAMIC_EQ_DB) out.push(`A ${(-processing.rangeDb).toFixed(1)} dB dynamic dip is deeper than Audiosous makes on its own.`);
      if (processing.filter.q < AUTO_RANGES.minQ || processing.filter.q > AUTO_RANGES.maxQ) out.push(`Q ${processing.filter.q.toFixed(2)} is outside the broad ${AUTO_RANGES.minQ}–${AUTO_RANGES.maxQ} range; narrow moving notches are easy to hear.`);
      break;
    case "transient":
      if (Math.abs(processing.attack) > REVIEW_TRANSIENT + 0.001) out.push(`Attack ${Math.round(processing.attack * 100)}% is larger than Audiosous changes on its own.`);
      if (Math.abs(processing.sustain) > 0.15 + 0.001) out.push(`Sustain ${Math.round(processing.sustain * 100)}% changes the body of every hit noticeably.`);
      break;
  }
  if (Math.abs(evaluation.levelChangeDb) > 3) out.push(`It changes the stem's average level by ${formatSignedDb(evaluation.levelChangeDb)} dB, which is a level decision as much as a dynamics one.`);
  return out.slice(0, 4);
}

export function needsReview(processing: DynamicsProcessing, confidence: number, warnings: string[]): boolean {
  if (confidence < REVIEW_CONFIDENCE) return true;
  if (warnings.length > 0) return true;
  if (processing.type === "ducking" && -processing.rangeDb > REVIEW_DUCK_DB) return true;
  return false;
}

/* ------------------------------------------------------------------ evaluation */

const decoded = new WeakMap<object, Map<string, Float32Array>>();

function series(owner: object, key: string, text: string): Float32Array {
  let cache = decoded.get(owner);
  if (!cache) {
    cache = new Map();
    decoded.set(owner, cache);
  }
  let values = cache.get(key);
  if (!values) {
    values = decodeEnvelopeSeries(text);
    cache.set(key, values);
  }
  return values;
}

/** Re-reads a row's effect from its evidence. Used by the planner for every candidate and by the editor. */
export function evaluateDynamics(evidence: DynamicsEvidence, processing: DynamicsProcessing, scope: DynamicsScope): Evaluated {
  const detail = evidence.detail;
  switch (detail.kind) {
    case "level":
      if (processing.type !== "compressor") break;
      return evaluateLevel(detail, processing);
    case "collision":
      if (processing.type !== "ducking") break;
      return evaluateCollision(detail, processing);
    case "masking":
      if (processing.type !== "dynamic-eq" && processing.type !== "ducking") break;
      return evaluateMasking(detail, processing);
    case "transient":
      if (processing.type !== "transient") break;
      return evaluateTransient(detail, processing);
  }
  void scope;
  return emptyEvaluation();
}

function emptyEvaluation(): Evaluated {
  return {
    method: "envelope-simulation",
    reductionP50Db: 0,
    reductionP95Db: 0,
    reductionMaxDb: 0,
    levelChangeDb: 0,
    spreadBeforeDb: null,
    spreadAfterDb: null,
    crestBeforeDb: null,
    crestAfterDb: null,
    peakChangeDb: null,
    conflictBeforeDb: null,
    conflictAfterDb: null,
    collisionBefore: null,
    collisionAfter: null,
    outsideChangeDb: null,
    recovery: null,
    transientBeforeDb: null,
    transientAfterDb: null,
    attackOverMixBeforeDb: null,
    attackOverMixAfterDb: null,
    timeline: { startSeconds: 0, hopSeconds: HOP_SECONDS, values: [] },
  };
}

export function evaluateLevel(detail: LevelEvidence, processing: CompressorProcessing): Evaluated {
  const detector = series(detail, "detector", detail.detector);
  const peak = series(detail, "peak", detail.peak);
  const reference = series(detail, "reference", detail.reference);
  const frames = detector.length;
  const after = simulateCompressor(detector, processing, 0, frames);
  const before = detail.existing ? simulateCompressor(detector, detail.existing, 0, frames) : new Float32Array(frames);
  const offset = new Float32Array(frames);
  for (const item of detail.offsets) for (let frame = Math.max(0, item.start); frame < Math.min(frames, item.end); frame += 1) offset[frame] = item.db;
  const heard = (reduction: Float32Array, makeup: number) => {
    const out = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) out[frame] = detector[frame]! - reduction[frame]! + makeup + offset[frame]!;
    return out;
  };
  const heardBefore = heard(before, detail.existing?.makeupDb ?? 0);
  const heardAfter = heard(after, processing.makeupDb);
  const spreadBefore = spreadOf(sustainedLevels(heardBefore, reference, detail.loudestCellDb, 0, frames), SWING_DB);
  const spreadAfter = spreadOf(sustainedLevels(heardAfter, reference, detail.loudestCellDb, 0, frames), SWING_DB);
  const playing = playingFrames(reference, detail.loudestCellDb, frames);
  const reductions = playing.map((frame) => after[frame]!);
  const powerMean = (values: Float32Array, list: number[]) => 10 * Math.log10(Math.max(1e-20, list.reduce((total, frame) => total + 10 ** (values[frame]! / 10), 0) / Math.max(1, list.length)));
  const levelBefore = powerMean(heardBefore, playing);
  const levelAfter = powerMean(heardAfter, playing);
  const peaks = (reduction: Float32Array, makeup: number) => playing.map((frame) => peak[frame]! - reduction[frame]! + makeup + offset[frame]!);
  const peakBefore = percentile(peaks(before, detail.existing?.makeupDb ?? 0), 0.99);
  const peakAfter = percentile(peaks(after, processing.makeupDb), 0.99);
  return {
    ...emptyEvaluation(),
    reductionP50Db: round2(percentile(reductions, 0.5)),
    reductionP95Db: round2(percentile(reductions, 0.95)),
    reductionMaxDb: round2(reductions.reduce((largest, value) => Math.max(largest, value), 0)),
    levelChangeDb: round2(levelAfter - levelBefore),
    spreadBeforeDb: round2(spreadBefore.spreadDb),
    spreadAfterDb: round2(spreadAfter.spreadDb),
    crestBeforeDb: round2(peakBefore - levelBefore),
    crestAfterDb: round2(peakAfter - levelAfter),
    peakChangeDb: round2(peakAfter - peakBefore),
    timeline: { startSeconds: round2(detail.start * HOP_SECONDS), hopSeconds: round4((frames * HOP_SECONDS) / Math.max(1, Math.min(400, frames))), values: downsampleMax(after, 400) },
  };
}

function playingFrames(reference: Float32Array, loudestCellDb: number, frames: number): number[] {
  const out: number[] = [];
  for (let cell = 0; cell + CELL_FRAMES <= frames; cell += CELL_FRAMES) {
    let total = 0;
    for (let frame = cell; frame < cell + CELL_FRAMES; frame += 1) total += 10 ** (reference[frame]! / 10);
    const db = 10 * Math.log10(Math.max(total / CELL_FRAMES, 1e-20));
    if (db > -60 && db >= loudestCellDb - 30) for (let frame = cell; frame < cell + CELL_FRAMES; frame += 1) out.push(frame);
  }
  return out;
}

/** How long after a key onset counts as "the hit": 80 ms, where a kick's low end lives. */
const HIT_FRAMES = 8;
/** Frames this long after a hit are "between hits" for recovery and the outside price. */
const BETWEEN_FRAMES = 15;

export function evaluateCollision(detail: CollisionEvidence, processing: DuckingProcessing): Evaluated {
  const keyPeak = series(detail, "keyPeak", detail.keyPeak);
  const keyRms = series(detail, "keyRms", detail.keyRms);
  const keyLow = series(detail, "keyLow", detail.keyLow);
  const targetLow = series(detail, "targetLow", detail.targetLow);
  const targetRms = series(detail, "targetRms", detail.targetRms);
  const frames = targetLow.length;
  const after = simulateDucking(keyPeak, keyRms, processing, 0, frames);
  const before = detail.existing ? simulateDucking(keyPeak, keyRms, detail.existing, 0, frames) : new Float32Array(frames);
  const hit = new Uint8Array(frames);
  const near = new Uint8Array(frames);
  for (const onset of detail.onsets) {
    for (let frame = onset; frame < Math.min(frames, onset + HIT_FRAMES); frame += 1) hit[frame] = 1;
    for (let frame = onset; frame < Math.min(frames, onset + BETWEEN_FRAMES); frame += 1) near[frame] = 1;
  }
  const gaps = (reduction: Float32Array) =>
    detail.onsets.map((onset) => {
      let target = 0;
      let key = 0;
      let count = 0;
      for (let frame = onset; frame < Math.min(frames, onset + HIT_FRAMES); frame += 1) {
        target += 10 ** ((targetLow[frame]! - reduction[frame]!) / 10);
        key += 10 ** (keyLow[frame]! / 10);
        count += 1;
      }
      return count > 0 ? 10 * Math.log10(Math.max(target, 1e-20) / Math.max(key, 1e-20)) : -60;
    });
  const gapsBefore = gaps(before);
  const gapsAfter = gaps(after);
  const share = (values: number[]) => (values.length > 0 ? values.filter((gap) => gap >= -3).length / values.length : 0);
  const mean = (values: number[]) => (values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0);
  const active: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) if (targetRms[frame]! > -70) active.push(frame);
  const level = (reduction: Float32Array, list: number[]) =>
    10 * Math.log10(Math.max(1e-20, list.reduce((total, frame) => total + 10 ** ((targetRms[frame]! - reduction[frame]!) / 10), 0) / Math.max(1, list.length)));
  const between = active.filter((frame) => near[frame] === 0);
  const hits: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) if (hit[frame] === 1) hits.push(after[frame]!);
  return {
    ...emptyEvaluation(),
    reductionP50Db: round2(percentile(hits, 0.5)),
    reductionP95Db: round2(percentile(hits, 0.95)),
    reductionMaxDb: round2(hits.reduce((largest, value) => Math.max(largest, value), 0)),
    levelChangeDb: round2(level(after, active) - level(before, active)),
    conflictBeforeDb: round2(mean(gapsBefore)),
    conflictAfterDb: round2(mean(gapsAfter)),
    collisionBefore: round3(share(gapsBefore)),
    collisionAfter: round3(share(gapsAfter)),
    outsideChangeDb: round2(between.length > 0 ? level(after, between) - level(before, between) : 0),
    recovery: round3(between.length > 0 ? between.filter((frame) => after[frame]! < 0.5).length / between.length : 1),
    timeline: { startSeconds: round2(detail.start * HOP_SECONDS), hopSeconds: round4((frames * HOP_SECONDS) / Math.max(1, Math.min(400, frames))), values: downsampleMax(after, 400) },
  };
}

/** The key detector's band level: the key's raw grid bands through a constant-peak band-pass at `hz`, Q `q`. */
export function detectorBandDb(bands: readonly number[], edgesHz: readonly number[], hz: number, q: number): number {
  let total = 0;
  for (let band = 0; band < bands.length; band += 1) {
    const center = Math.sqrt(edgesHz[band]! * edgesHz[band + 1]!);
    const ratio = center / hz - hz / center;
    total += 10 ** (bands[band]! / 10) / (1 + q * q * ratio * ratio);
  }
  return 10 * Math.log10(Math.max(total, 1e-20));
}

export function evaluateMasking(detail: MaskingEvidence, processing: DynamicEqProcessing | DuckingProcessing): Evaluated {
  const count = detail.steps.length;
  const centers = detail.edgesHz.slice(0, -1).map((low, band) => Math.sqrt(low * detail.edgesHz[band + 1]!));
  // The detector per step, then the activation per step on the planner's grid.
  const detector =
    processing.type === "dynamic-eq"
      ? detail.keyBands.map((bands) => detectorBandDb(bands, detail.edgesHz, processing.filter.frequencyHz, processing.filter.q))
      : detail.keyBands.map((bands) => 10 * Math.log10(Math.max(1e-20, bands.reduce((total, db) => total + 10 ** (db / 10), 0))));
  const activation = simulateDynamicEq(detector, processing, detail.stepSeconds);
  const existingActivation = detail.existing
    ? simulateDynamicEq(
        detail.existing.type === "dynamic-eq"
          ? detail.keyBands.map((bands) => detectorBandDb(bands, detail.edgesHz, (detail.existing as DynamicEqProcessing).filter.frequencyHz, (detail.existing as DynamicEqProcessing).filter.q))
          : detector,
        detail.existing,
        detail.stepSeconds,
      )
    : null;
  const gainAt = (row: DynamicEqProcessing | DuckingProcessing, value: number, band: number): number => {
    if (row.type === "ducking") return row.rangeDb * value;
    return filterMagnitudeDb({ kind: "bell", frequencyHz: row.filter.frequencyHz, gainDb: row.rangeDb * value, q: row.filter.q }, centers[band]!);
  };
  const targetAt = (step: number, band: number, which: "before" | "after"): number => {
    const base = detail.targetBands[step]![band]!;
    if (which === "before") return detail.existing && existingActivation ? base + gainAt(detail.existing, existingActivation[step]!, band) : base;
    return base + gainAt(processing, activation[step]!, band);
  };
  // Masked share of the protected stem's identity while the key plays (the EQ planner's competition curve).
  const masked = (which: "before" | "after") => {
    let competed = 0;
    let identity = 0;
    let gap = 0;
    let gapWeight = 0;
    for (let step = 0; step < count; step += 1) {
      if (!detail.keyActive[step]) continue;
      const protectedBands = detail.protectedBands[step]!;
      const total = protectedBands.reduce((sum, db) => sum + 10 ** (db / 10), 0);
      if (total <= 0) continue;
      for (let band = 0; band < 24; band += 1) {
        const share = 10 ** (protectedBands[band]! / 10) / total;
        const weight = share * detail.weights[band]!;
        const difference = targetAt(step, band, which) - protectedBands[band]!;
        competed += weight * maskCurve(difference);
        identity += weight;
        gap += weight * difference;
        gapWeight += weight;
      }
    }
    return { share: identity > 0 ? competed / identity : 0, gap: gapWeight > 0 ? gap / gapWeight : 0 };
  };
  const before = masked("before");
  const after = masked("after");
  const power = (which: "before" | "after", keyed: boolean | null) => {
    let total = 0;
    let used = 0;
    for (let step = 0; step < count; step += 1) {
      if (keyed !== null && detail.keyActive[step] !== keyed) continue;
      for (let band = 0; band < 24; band += 1) total += 10 ** (targetAt(step, band, which) / 10);
      used += 1;
    }
    return used > 0 ? 10 * Math.log10(Math.max(total / used, 1e-20)) : null;
  };
  const allBefore = power("before", null);
  const allAfter = power("after", null);
  const offBefore = power("before", false);
  const offAfter = power("after", false);
  const depth = (step: number) => (processing.type === "ducking" ? -processing.rangeDb * activation[step]! : -processing.rangeDb * activation[step]!);
  const keyed: number[] = [];
  for (let step = 0; step < count; step += 1) if (detail.keyActive[step]) keyed.push(depth(step));
  const timeline = detail.steps.map((_, step) => depth(step));
  return {
    ...emptyEvaluation(),
    reductionP50Db: round2(percentile(keyed, 0.5)),
    reductionP95Db: round2(percentile(keyed, 0.95)),
    reductionMaxDb: round2(keyed.reduce((largest, value) => Math.max(largest, value), 0)),
    levelChangeDb: round2(allBefore !== null && allAfter !== null ? allAfter - allBefore : 0),
    conflictBeforeDb: round2(before.gap),
    conflictAfterDb: round2(after.gap),
    collisionBefore: round3(Math.min(1, before.share)),
    collisionAfter: round3(Math.min(1, after.share)),
    outsideChangeDb: round2(offBefore !== null && offAfter !== null ? offAfter - offBefore : 0),
    timeline: { startSeconds: round2((detail.steps[0] ?? 0) * detail.stepSeconds), hopSeconds: round4(detail.stepSeconds), values: timeline.slice(0, 400).map(round2) },
  };
}

export function evaluateTransient(detail: TransientEvidence, processing: TransientProcessing): Evaluated {
  const changeOf = (row: TransientProcessing | null, onset: TransientEvidence["onsets"][number]) => (row ? transientGainDb(onset.riseDb, row.attack, row.sustain) : { attackDb: 0, bodyDb: 0 });
  const ratios = (row: TransientProcessing | null) =>
    detail.onsets.map((onset) => {
      const change = changeOf(row, onset);
      return onset.attackDb + change.attackDb - (onset.bodyDb + change.bodyDb);
    });
  const overMix = (row: TransientProcessing | null) => detail.onsets.map((onset) => onset.attackDb + changeOf(row, onset).attackDb - onset.mixDb);
  // Level: the attack frames (2 per onset) and body frames (10 per onset) change; everything else does not.
  const levelPower = 10 ** (detail.levelDb / 10) * Math.max(1, detail.frames);
  const levelWith = (row: TransientProcessing | null) => {
    let total = levelPower;
    for (const onset of detail.onsets) {
      const change = changeOf(row, onset);
      total += 2 * 10 ** (onset.attackDb / 10) * (10 ** (change.attackDb / 10) - 1);
      total += 10 * 10 ** (onset.bodyDb / 10) * (10 ** (change.bodyDb / 10) - 1);
    }
    return 10 * Math.log10(Math.max(total, 1e-20));
  };
  const before = ratios(detail.existing);
  const after = ratios(processing);
  const gains = detail.onsets.map((onset) => Math.abs(changeOf(processing, onset).attackDb));
  return {
    ...emptyEvaluation(),
    reductionP50Db: round2(percentile(gains, 0.5)),
    reductionP95Db: round2(percentile(gains, 0.95)),
    reductionMaxDb: round2(gains.reduce((largest, value) => Math.max(largest, value), 0)),
    levelChangeDb: round2(levelWith(processing) - levelWith(detail.existing)),
    transientBeforeDb: round2(percentile(before, 0.5)),
    transientAfterDb: round2(percentile(after, 0.5)),
    attackOverMixBeforeDb: round2(percentile(overMix(detail.existing), 0.5)),
    attackOverMixAfterDb: round2(percentile(overMix(processing), 0.5)),
    timeline: { startSeconds: 0, hopSeconds: HOP_SECONDS, values: [] },
  };
}

/* ------------------------------------------------------------------ proxy check */

export interface DynamicsProxyCheck {
  id: string;
  reductionP50Db: number;
  reductionP95Db: number;
  reductionMaxDb: number;
  levelBeforeDb: number;
  levelAfterDb: number;
  spreadBeforeDb: number;
  spreadAfterDb: number;
  transientBeforeDb: number | null;
  transientAfterDb: number | null;
  bandOnChangeDb: number | null;
  bandOffChangeDb: number | null;
  recovered: number | null;
  seconds: number;
}

/**
 * Folds the playback-proxy measurements into the plan: the native DSP on real audio, where the problem happens.
 * A row whose measured effect is far from the prediction, or fails its own purpose, goes to review with the numbers.
 */
export function withDynamicsProxyChecks(plan: DynamicsPlan, checks: DynamicsProxyCheck[], failed = 0): DynamicsPlan {
  const byId = new Map(checks.map((check) => [check.id, check]));
  let disagreements = 0;
  const changes = plan.changes.map((change) => {
    const check = byId.get(change.id);
    if (!check || !change.evaluation) return change;
    const verdict = proxyVerdict(change, check);
    const evaluation = {
      ...change.evaluation,
      proxy: {
        reductionP50Db: round2(check.reductionP50Db),
        reductionP95Db: round2(check.reductionP95Db),
        reductionMaxDb: round2(check.reductionMaxDb),
        levelChangeDb: round2(check.levelAfterDb - check.levelBeforeDb),
        spreadBeforeDb: change.processing.type === "compressor" ? round2(check.spreadBeforeDb) : null,
        spreadAfterDb: change.processing.type === "compressor" ? round2(check.spreadAfterDb) : null,
        transientBeforeDb: check.transientBeforeDb === null ? null : round2(check.transientBeforeDb),
        transientAfterDb: check.transientAfterDb === null ? null : round2(check.transientAfterDb),
        bandOnChangeDb: check.bandOnChangeDb === null ? null : round2(check.bandOnChangeDb),
        bandOffChangeDb: check.bandOffChangeDb === null ? null : round2(check.bandOffChangeDb),
        recovered: check.recovered === null ? null : round3(check.recovered),
        seconds: Math.round(check.seconds * 10) / 10,
        agrees: verdict === null,
      },
    };
    if (verdict === null) return { ...change, evaluation };
    disagreements += 1;
    const confidence = Math.max(0.2, Math.round((change.confidence - 0.1) * 100) / 100);
    return {
      ...change,
      evaluation,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      status: change.status === "proposed" ? ("needs-review" as const) : change.status,
      reasons: [...change.reasons.slice(0, 5), `On the playback proxy (${evaluation.proxy.seconds.toFixed(1)} s): ${verdict} So it waits for a listen.`.slice(0, 600)],
    };
  });
  const notes = plan.summary.notes.filter((note) => !note.startsWith("Proxy check:"));
  const checked = checks.filter((check) => plan.changes.some((change) => change.id === check.id)).length;
  if (checked > 0 || failed > 0) {
    notes.push(
      `Proxy check: ${checked} ${checked === 1 ? "row was" : "rows were"} run through the native dynamics on the 48 kHz playback proxies; ${checked - disagreements} matched the prediction${disagreements > 0 ? `, ${disagreements} went to review` : ""}${failed > 0 ? `, ${failed} could not be checked` : ""}.`,
    );
  }
  return refreshCounts({ ...plan, changes, summary: { ...plan.summary, notes: notes.slice(-12) } });
}

/** Null when the measurement supports the row; otherwise what went wrong, in words. */
function proxyVerdict(change: DynamicsRecommendation, check: DynamicsProxyCheck): string | null {
  const predicted = change.evaluation!;
  switch (change.processing.type) {
    case "compressor": {
      const target = change.targetReductionDb;
      if (target && check.reductionP95Db > Math.max(target.max + 2, predicted.reductionP95Db * 1.6 + 1)) {
        return `it reduced the loudest passages by ${check.reductionP95Db.toFixed(1)} dB against ${predicted.reductionP95Db.toFixed(1)} dB predicted.`;
      }
      if (check.reductionP95Db < Math.min(0.5, predicted.reductionP95Db * 0.4)) return `it barely engaged (${check.reductionP95Db.toFixed(1)} dB on the loudest passages).`;
      if (check.spreadAfterDb > check.spreadBeforeDb - 0.3) return `the sustained-level spread went ${check.spreadBeforeDb.toFixed(1)} → ${check.spreadAfterDb.toFixed(1)} dB, not narrower.`;
      return null;
    }
    case "ducking": {
      if (check.bandOnChangeDb !== null && check.bandOnChangeDb > -0.5) return `the target's level while the key plays changed only ${formatSignedDb(check.bandOnChangeDb)} dB.`;
      if (check.recovered !== null && check.recovered < 0.5) return `the target was back to full level only ${Math.round(check.recovered * 100)}% of the time the key was quiet.`;
      return null;
    }
    case "dynamic-eq": {
      if (check.bandOnChangeDb !== null && check.bandOnChangeDb > -0.3) return `the band dipped only ${formatSignedDb(check.bandOnChangeDb)} dB while the key played.`;
      if (check.bandOffChangeDb !== null && check.bandOffChangeDb < -0.75) return `the band also dropped ${formatSignedDb(check.bandOffChangeDb)} dB while the key was silent.`;
      return null;
    }
    case "transient": {
      if (check.transientBeforeDb === null || check.transientAfterDb === null) return null;
      const measured = check.transientAfterDb - check.transientBeforeDb;
      const wanted = change.processing.attack;
      if (Math.sign(measured) !== Math.sign(wanted) || Math.abs(measured) < 0.3) return `attack over body moved ${formatSignedDb(measured)} dB, not the way the row intends.`;
      return null;
    }
  }
}

/* ------------------------------------------------------------------ audition, apply */

export interface DynamicsAuditionOptions {
  mode: "current" | "candidate";
  focusId?: string | null;
  focusSide?: "bypassed" | "recommended";
  /** Compensate each processed stem's predicted level change, so the comparison is not won by loudness. */
  levelMatch?: boolean;
}

export type EngineDynamicsNode =
  | { type: "compressor"; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number; makeupDb: number }
  | { type: "ducking"; keyTrackId: string; keyDetector: "transient" | "smooth"; thresholdDb: number; rangeDb: number; attackMs: number; releaseMs: number }
  | { type: "transient"; attack: number; sustain: number }
  | { type: "dynamic-eq"; frequencyHz: number; q: number; keyTrackId: string | null; keyDetector: "transient" | "smooth"; thresholdDb: number; rangeDb: number; attackMs: number; releaseMs: number };

export interface EngineTrackDynamics {
  trackId: string;
  nodes: EngineDynamicsNode[];
  regions: Array<{ startSeconds: number; endSeconds: number; nodes: EngineDynamicsNode[] }>;
}

export interface DynamicsAudition {
  tracks: EngineTrackDynamics[];
  /** Level-match offsets in the audition only: whole-song per track, and per section window. */
  compensation: Array<{ trackId: string; sectionId: string | null; startSeconds: number; endSeconds: number; gainDb: number }>;
  note: string;
}

/** Largest level-match boost the audition adds. Compression rarely costs more than this on average. */
const MAX_COMPENSATION_DB = 3;

/**
 * Saved dynamics plus the included candidate rows, as the engine plays them. The saved project is not touched.
 * Single-row audition plays the whole mix with only that row switched.
 */
export function dynamicsAudition(document: ProjectDocument, plan: DynamicsPlan | null, options: DynamicsAuditionOptions): DynamicsAudition {
  const focusId = options.focusId ?? null;
  const focusSide = options.focusSide ?? "recommended";
  const chosen = (plan?.changes ?? []).filter((change) => {
    if (focusId === change.id) return focusSide === "recommended";
    if (options.mode === "current") return false;
    return dynamicsRecommendationIncluded(change, "preview");
  });
  const candidate = chosen.length > 0 ? applyRows(document, chosen) : document;
  const compensation: DynamicsAudition["compensation"] = [];
  if (options.levelMatch !== false) {
    for (const change of chosen) {
      const delta = change.evaluation?.levelChangeDb ?? 0;
      if (Math.abs(delta) < 0.05) continue;
      const gainDb = Math.round(Math.min(MAX_COMPENSATION_DB, Math.max(-MAX_COMPENSATION_DB, -delta)) * 100) / 100;
      const section = change.scope.type === "section" ? document.sections.find((item) => item.id === (change.scope as { sectionId: string }).sectionId) : null;
      compensation.push({
        trackId: change.trackId,
        sectionId: section?.id ?? null,
        startSeconds: section?.startTime ?? 0,
        endSeconds: section?.endTime ?? document.project.durationSeconds,
        gainDb,
      });
    }
  }
  return { tracks: engineDynamics(candidate), compensation, note: auditionNote(options, compensation.length > 0) };
}

/** Every runnable saved dynamics node, track-wide and per section, in the engine's form. */
export function engineDynamics(document: ProjectDocument): EngineTrackDynamics[] {
  const out: EngineTrackDynamics[] = [];
  for (const track of document.tracks) {
    const runnable = (nodes: DynamicsNode[]) => orderDynamics(nodes.filter((node) => dynamicsNodeRunnable(document, track.id, node))).map(engineDynamicsNode);
    const nodes = runnable(trackDynamicsNodes(document, track.id));
    const regions = document.sections
      .map((section) => ({ startSeconds: section.startTime, endSeconds: section.endTime, nodes: runnable(sectionDynamicsNodes(document, track.id, section.id)) }))
      .filter((region) => region.nodes.length > 0);
    if (nodes.length > 0 || regions.length > 0) out.push({ trackId: track.id, nodes, regions });
  }
  return out;
}

/** One saved node in the engine's form. */
export function engineDynamicsNode(node: DynamicsNode): EngineDynamicsNode {
  switch (node.type) {
    case "compressor":
      return { type: "compressor", thresholdDb: node.thresholdDb, ratio: node.ratio, attackMs: node.attackMs, releaseMs: node.releaseMs, kneeDb: node.kneeDb, makeupDb: node.makeupDb };
    case "ducking":
      return { type: "ducking", keyTrackId: node.keyTrackId, keyDetector: node.keyDetector, thresholdDb: node.thresholdDb, rangeDb: node.rangeDb, attackMs: node.attackMs, releaseMs: node.releaseMs };
    case "transient":
      return { type: "transient", attack: node.attack, sustain: node.sustain };
    case "dynamic-eq":
      return {
        type: "dynamic-eq",
        frequencyHz: node.filter.frequencyHz,
        q: node.filter.q,
        keyTrackId: node.keyTrackId,
        keyDetector: node.keyDetector,
        thresholdDb: node.thresholdDb,
        rangeDb: node.rangeDb,
        attackMs: node.attackMs,
        releaseMs: node.releaseMs,
      };
  }
}

/** Writes the chosen rows into the processing graphs as dynamics-plan nodes. One call is one undo step for the caller. */
export function applyDynamicsPlan(document: ProjectDocument, plan: DynamicsPlan, mode: DynamicsApplyMode): ProjectDocument {
  const chosen = plan.changes.filter((change) => (mode === "accepted" ? change.status === "accepted" : dynamicsRecommendationIncluded(change, "all")));
  return withUpdatedAt(applyRows(document, chosen));
}

function applyRows(document: ProjectDocument, rows: DynamicsRecommendation[]): ProjectDocument {
  let next = document;
  const used = new Set<string>();
  for (const track of document.tracks) for (const node of [...track.processing.nodes, ...track.processing.dynamics]) used.add(node.id);
  for (const row of document.sectionTrackSettings) for (const node of [...row.processing.nodes, ...row.processing.dynamics]) used.add(node.id);
  for (const change of rows) {
    let id = `dyn-${fnv1a(change.id)}`;
    for (let attempt = 1; used.has(id); attempt += 1) id = `dyn-${fnv1a(`${change.id}#${attempt}`)}`;
    used.add(id);
    const node = { ...change.processing, id, enabled: true, origin: "dynamics-plan" as const, note: change.reasons[0]!.slice(0, 400) } as DynamicsNode;
    const replace = (nodes: DynamicsNode[]) => {
      const at = change.replacesNodeId ? nodes.findIndex((item) => item.id === change.replacesNodeId) : -1;
      return at < 0 ? [...nodes, node] : nodes.map((item, index) => (index === at ? node : item));
    };
    const result =
      change.scope.type === "global"
        ? setTrackDynamicsNodes(next, change.trackId, replace(trackDynamicsNodes(next, change.trackId)))
        : setSectionDynamicsNodes(next, change.trackId, change.scope.sectionId, replace(sectionDynamicsNodes(next, change.trackId, change.scope.sectionId)));
    if (result.ok) next = result.document;
  }
  return next;
}

function auditionNote(options: DynamicsAuditionOptions, matched: boolean): string {
  const fairness = matched
    ? " Each processed stem is level-matched: its fader is raised by the average level the processing is predicted to remove, in this audition only, so the comparison is about dynamics, not loudness."
    : options.levelMatch === false
      ? " Level matching is off: processed stems play at their processed level."
      : "";
  if (options.focusId) return `Single-row audition plays the whole mix. Only this row's processing is switched.${fairness}`;
  if (options.mode === "current") return "Current plays the saved mix with its saved dynamics.";
  return `Dynamics Candidate plays the saved mix with the included dynamics rows.${fairness}`;
}

/* ------------------------------------------------------------------ formatting */

export function describeProcessing(processing: DynamicsProcessing, trackName: (id: string) => string = (id) => id): string {
  switch (processing.type) {
    case "compressor":
      return `${processing.ratio.toFixed(1)}:1 at ${formatSignedDb(processing.thresholdDb)} dB, ${trimMs(processing.attackMs)} / ${trimMs(processing.releaseMs)} ms`;
    case "ducking":
      return `from ${trackName(processing.keyTrackId)}, up to ${formatSignedDb(processing.rangeDb)} dB, ${trimMs(processing.attackMs)} / ${trimMs(processing.releaseMs)} ms`;
    case "transient":
      return `attack ${signedPercent(processing.attack)}, sustain ${signedPercent(processing.sustain)}`;
    case "dynamic-eq":
      return `${formatHz(processing.filter.frequencyHz)}, Q ${processing.filter.q.toFixed(1)}, up to ${formatSignedDb(processing.rangeDb)} dB${processing.keyTrackId ? `, key ${trackName(processing.keyTrackId)}` : ""}`;
  }
}

export const PROCESSOR_LABELS: Record<DynamicsProcessing["type"], string> = {
  compressor: "Compressor",
  ducking: "Duck",
  transient: "Transient",
  "dynamic-eq": "Dynamic EQ",
};

export function formatHz(hz: number): string {
  return hz >= 1_000 ? `${(hz / 1_000).toFixed(hz >= 10_000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

export function signedPercent(value: number): string {
  const rounded = Math.round(value * 100);
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

function trimMs(ms: number): string {
  return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

function refreshCounts(plan: DynamicsPlan): DynamicsPlan {
  return { ...plan, summary: { ...plan.summary, reviewCount: plan.changes.filter((change) => change.status === "needs-review").length, changeCount: plan.changes.length } };
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function clampGain(value: number): number {
  return Math.round(Math.min(GAIN_DB_MAX, Math.max(GAIN_DB_MIN, value)) * 10) / 10;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100 || 0;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000 || 0;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000 || 0;
}
