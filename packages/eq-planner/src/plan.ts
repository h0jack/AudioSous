import { ANALYSIS_ENGINE_VERSION } from "@audiosous/analysis-contract";
import { confidenceLabel, estimateSumPeakDbfs, formatSignedDb, headroomTrimDb, type SourceFingerprint } from "@audiosous/balance-planner";
import {
  EQ_FILTER_LABELS,
  EQ_LIMITS,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  MAX_SECTION_EQ_NODES,
  MAX_TRACK_EQ_NODES,
  eqFilterSchema,
  enabledFilters,
  isPassFilter,
  normalizeEqFilter,
  processingIdentity,
  sectionEqNodes,
  sectionSettingInUse,
  setSectionEqNodes,
  trackEqNodes,
  withUpdatedAt,
  type EqFilter,
  type EqNode,
  type ProjectDocument,
} from "@audiosous/project-model";
import { z } from "zod";
import { bandPowerGain, chainMagnitudeDb } from "./response";
import { EQ_PLAN_VERSION, EQ_PLANNER_VERSION, EQ_STRENGTHS, REVIEW_BOOST_DB, REVIEW_CONFIDENCE, REVIEW_CUT_DB, REVIEW_Q, type EqSettings } from "./settings";

const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("section"), sectionId: z.string().min(1) }),
]);

export type EqScope = z.infer<typeof scopeSchema>;

const regionSchema = z.object({
  centerHz: z.number().finite().positive(),
  lowHz: z.number().finite().positive(),
  highHz: z.number().finite().positive(),
  sharedEnergy: z.number().finite().min(0).max(1),
  maskedShare: z.number().finite().min(0).max(1),
  levelDifferenceDb: z.number().finite(),
  severity: z.number().finite().min(0).max(1),
  persistence: z.number().finite().min(0).max(1),
});

export type InteractionRegionDto = z.infer<typeof regionSchema>;

/** Band levels (dB) for drawing and for re-checking an edited filter without the planner. */
const evidenceSchema = z.object({
  bandsHz: z.array(z.number().finite().positive()).max(32),
  edgesHz: z.array(z.number().finite().positive()).max(33),
  /** The track the move is on (the competitor, for a cut) and the track it protects. */
  targetDb: z.array(z.number().finite()).max(32),
  referenceDb: z.array(z.number().finite()).max(32),
  /** A saved filter the move replaces. The target levels already include it, so its response is divided out. */
  replaces: eqFilterSchema.nullable(),
  /** Everything else playing at the same time (including the target), for judging a move in context. */
  contextDb: z.array(z.number().finite()).max(32).nullable(),
  /** What matters for the protected track's role, per band, 0..1. */
  weights: z.array(z.number().finite().min(0).max(1)).max(32),
  /** First and last band of the conflict the move was planned for, when it has one. */
  focus: z.tuple([z.number().int().min(0).max(31), z.number().int().min(0).max(31)]).nullable(),
  /** Co-active windows, seconds, for checking on the playback proxies. */
  windows: z.array(z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()])).max(24),
});

export type EqEvidence = z.infer<typeof evidenceSchema>;

export const interactionSchema = z.object({
  id: z.string().min(1),
  scope: scopeSchema,
  scopeName: z.string(),
  trackA: z.string().min(1),
  trackB: z.string().min(1),
  kind: z.enum(["kick-bass", "lead-support", "hierarchy", "equal", "layered", "low-end", "intent", "presence"]),
  tierA: z.string(),
  tierB: z.string(),
  severity: z.number().finite().min(0).max(1),
  confidence: z.number().finite().min(0).max(1),
  simultaneousActivity: z.number().finite().min(0).max(1),
  coverage: z.number().finite().min(0).max(1),
  overlap: z.number().finite().min(0).max(1),
  stereoSeparation: z.number().finite().min(0).max(1),
  protectedTrackId: z.string().nullable(),
  yieldingTrackId: z.string().nullable(),
  regions: z.array(regionSchema).max(2),
  outcome: z.enum(["recommendation", "ambiguous", "below-threshold", "layered", "no-benefit", "review", "level"]),
  explanation: z.string().min(1).max(600),
  evidence: evidenceSchema,
});

export type TrackInteraction = z.infer<typeof interactionSchema>;

export const eqEvaluationSchema = z.object({
  method: z.literal("spectral-transfer"),
  /** Competed-for share of the protected track's weighted energy, before and after this filter. */
  before: z.number().finite().min(0).max(1),
  after: z.number().finite().min(0).max(1),
  improvement: z.number().finite(),
  /** How far the filter pulls the competitor under the protected track inside the conflict, weighted by where the conflict is. */
  gapReductionDb: z.number().finite(),
  /** The same, against everything else playing rather than the one competitor. Null without context. */
  contextGapReductionDb: z.number().finite().nullable(),
  /** Level change of the filtered track inside the conflict region, and over its whole spectrum. */
  regionChangeDb: z.number().finite(),
  identityChangeDb: z.number().finite(),
  passes: z.number().int().min(0).max(2),
  proxy: z
    .object({
      regionChangeDb: z.number().finite(),
      identityChangeDb: z.number().finite(),
      seconds: z.number().finite().nonnegative(),
      agrees: z.boolean(),
    })
    .nullable(),
});

export type EqEvaluation = z.infer<typeof eqEvaluationSchema>;

export const eqRecommendationSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  scope: scopeSchema,
  processing: z.object({ type: z.literal("eq"), filter: eqFilterSchema }),
  /** The filter as planned, kept so an edit can be compared and reset. */
  planned: eqFilterSchema,
  /** A saved filter this one replaces instead of stacking on it. */
  replacesNodeId: z.string().nullable(),
  protectedTrackIds: z.array(z.string()).max(4),
  interactionIds: z.array(z.string()).max(8),
  purpose: z.enum(["separation", "low-end", "high-end", "intent", "presence"]),
  confidence: z.number().finite().min(0).max(1),
  confidenceLabel: z.enum(["high", "medium", "low"]),
  status: z.enum(["proposed", "accepted", "rejected", "needs-review"]),
  edited: z.boolean(),
  reasons: z.array(z.string().min(1).max(600)).min(1).max(6),
  evaluation: eqEvaluationSchema.nullable(),
  evidence: evidenceSchema,
});

export type EqRecommendation = z.infer<typeof eqRecommendationSchema>;

export const eqPlanSchema = z.object({
  planVersion: z.literal(EQ_PLAN_VERSION),
  plannerVersion: z.literal(EQ_PLANNER_VERSION),
  kind: z.literal("frequency-balance"),
  createdAt: z.string().min(1),
  projectId: z.string().min(1),
  sourceAnalysisVersion: z.string().min(1),
  settings: z.object({ strength: z.enum(EQ_STRENGTHS) }),
  stateIdentity: z.string().min(1),
  summary: z.object({
    goal: z.literal("separation"),
    confidence: z.number().finite().min(0).max(1),
    headline: z.string().min(1),
    notes: z.array(z.string()).max(10),
    changeCount: z.number().int().nonnegative(),
    reviewCount: z.number().int().nonnegative(),
    pairsAnalyzed: z.number().int().nonnegative(),
    analysisSource: z.string(),
  }),
  changes: z.array(eqRecommendationSchema).max(128),
  interactions: z.array(interactionSchema).max(48),
  candidateTrim: z.object({ gainDb: z.number().finite(), reason: z.string().nullable() }),
  levels: z.array(
    z.object({
      trackId: z.string().min(1),
      peakDbfs: z.number().finite().nullable(),
      muted: z.boolean(),
      gainDb: z.number().finite(),
      /** Band shares (0..1) of the track's own spectrum, for the boost headroom estimate. */
      shares: z.array(z.number().finite().min(0).max(1)).max(32),
    }),
  ),
});

export type EqPlan = z.infer<typeof eqPlanSchema>;

/** Gain plans and EQ plans share one envelope and can be told apart by `kind`. */
export type MixPlanKind = "auto-balance" | "frequency-balance";

export function eqPlanStateIdentity(document: ProjectDocument, settings: EqSettings, fingerprints: SourceFingerprint[] = []): string {
  const files = new Map(fingerprints.map((file) => [file.trackId, file]));
  const payload = {
    projectId: document.project.id,
    analysis: ANALYSIS_ENGINE_VERSION,
    planner: EQ_PLANNER_VERSION,
    settings,
    tracks: document.tracks.map((track) => {
      const file = files.get(track.id);
      return [
        track.id,
        track.name,
        track.customLabel,
        track.role,
        track.gainDb,
        track.pan,
        track.muted,
        track.metadata.durationSeconds,
        file?.fileSizeBytes ?? track.metadata.fileSizeBytes,
        file?.modifiedAtNs ?? "",
      ];
    }),
    sections: document.sections.map((section) => [section.id, section.startTime, section.endTime, section.type, section.userIntent]),
    rows: [...document.sectionTrackSettings]
      .sort((left, right) => `${left.trackId}:${left.sectionId}`.localeCompare(`${right.trackId}:${right.sectionId}`))
      .map((row) => [row.trackId, row.sectionId, row.prominence, row.userIntent, row.overrides.gainDb, row.overrides.pan]),
    processing: processingIdentity(document),
  };
  return fnv1a(JSON.stringify(payload));
}

export function eqPlanIsStale(plan: EqPlan, document: ProjectDocument, fingerprints: SourceFingerprint[] = [], settings: EqSettings = plan.settings): boolean {
  return plan.projectId !== document.project.id || plan.stateIdentity !== eqPlanStateIdentity(document, settings, fingerprints);
}

export type EqApplyMode = "all" | "accepted";

/** Same rule as AutoBalance: rejected never, needs-review only once accepted, Apply accepted takes accepted only. */
export function eqRecommendationIncluded(change: Pick<EqRecommendation, "status">, mode: EqApplyMode | "preview"): boolean {
  if (change.status === "rejected") return false;
  if (mode === "accepted") return change.status === "accepted";
  if (change.status === "needs-review") return false;
  return change.status === "proposed" || change.status === "accepted";
}

export function eqRecommendationId(trackId: string, scope: EqScope, index: number): string {
  return `${trackId}::${scope.type === "global" ? "global" : `section::${scope.sectionId}`}::eq${index}`;
}

export function setEqRecommendationStatus(plan: EqPlan, id: string, status: EqRecommendation["status"]): EqPlan {
  return refreshEqTrim({ ...plan, changes: plan.changes.map((change) => (change.id === id ? { ...change, status } : change)) });
}

/** Edit bounds in the review table: wider than the planner uses, inside what the project stores. */
export const EDIT_LIMITS = {
  minHz: EQ_LIMITS.minHz,
  maxHz: EQ_LIMITS.maxHz,
  minGainDb: -12,
  maxGainDb: 6,
  minQ: 0.3,
  maxQ: 6,
} as const;

/**
 * Applies an edit to one recommendation and re-checks it against the evidence stored with it.
 * The planner does not run again.
 */
export function editEqRecommendation(plan: EqPlan, id: string, patch: Partial<EqFilter>): EqPlan {
  const changes = plan.changes.map((change) => {
    if (change.id !== id) return change;
    const merged = { ...change.processing.filter, ...patch };
    const filter = normalizeEqFilter({
      kind: merged.kind,
      frequencyHz: clamp(merged.frequencyHz, EDIT_LIMITS.minHz, EDIT_LIMITS.maxHz),
      gainDb: clamp(merged.gainDb, EDIT_LIMITS.minGainDb, EDIT_LIMITS.maxGainDb),
      q: clamp(merged.q, EDIT_LIMITS.minQ, EDIT_LIMITS.maxQ),
    });
    const edited = !sameFilter(filter, change.planned);
    const evaluation = change.evaluation ? { ...evaluateFilter(change.evidence, filter, change.purpose), passes: change.evaluation.passes, proxy: null } : null;
    return { ...change, processing: { type: "eq" as const, filter }, edited, evaluation };
  });
  return refreshEqTrim({ ...plan, changes });
}

export function resetEqRecommendation(plan: EqPlan, id: string): EqPlan {
  const change = plan.changes.find((item) => item.id === id);
  if (!change) return plan;
  return editEqRecommendation(plan, id, change.planned);
}

/**
 * Spectral-transfer check of one filter on the stored band levels:
 * competed-for share of the protected track before and after, the level change in the region,
 * and how much of the filtered track's own energy goes.
 */
export function evaluateFilter(evidence: EqEvidence, filter: EqFilter, purpose: EqRecommendation["purpose"]): Omit<EqEvaluation, "passes" | "proxy"> {
  const shape = evidence.bandsHz.map((_, band) => {
    const low = evidence.edgesHz[band]!;
    const high = evidence.edgesHz[band + 1]!;
    const gain = bandPowerGain([filter], low, high);
    return evidence.replaces ? gain / Math.max(1e-12, bandPowerGain([evidence.replaces], low, high)) : gain;
  });
  const target = evidence.targetDb.map((db) => 10 ** (db / 10));
  const reference = evidence.referenceDb.map((db) => 10 ** (db / 10));
  const boost = !isPassFilter(filter.kind) && filter.gainDb > 0 && purpose === "presence";
  // A cut filters the competitor. A presence boost filters the protected track itself.
  const victimBefore = boost ? target : reference;
  const maskerBefore = boost ? reference : target;
  const victimAfter = boost ? target.map((value, band) => value * shape[band]!) : reference;
  const maskerAfter = boost ? reference : target.map((value, band) => value * shape[band]!);
  // Judged inside the conflict the move was planned for (or, without one, where the filter acts).
  // A regional move is not expected to fix the whole spectrum.
  const region = regionBands(evidence, filter);
  const focus = evidence.focus ? range(evidence.focus[0], evidence.focus[1]) : region;
  const before = maskedFraction(victimBefore, maskerBefore, evidence.weights, focus);
  const after = maskedFraction(victimAfter, maskerAfter, evidence.weights, focus);
  const gapReductionDb = weightedGapReduction(victimBefore, maskerBefore, victimAfter, maskerAfter, evidence.weights, focus);
  let contextGapReductionDb: number | null = null;
  if (evidence.contextDb && !boost) {
    const context = evidence.contextDb.map((db) => 10 ** (db / 10));
    // The rest of the mix after the move: the filtered target's share replaced by its filtered self.
    const contextAfter = context.map((value, band) => Math.max(1e-20, value - target[band]! + target[band]! * shape[band]!));
    contextGapReductionDb = round2(weightedGapReduction(reference, context, reference, contextAfter, evidence.weights, focus));
  }
  const regionBefore = region.reduce((sum, band) => sum + target[band]!, 0);
  const regionAfter = region.reduce((sum, band) => sum + target[band]! * shape[band]!, 0);
  const totalBefore = target.reduce((sum, value) => sum + value, 0);
  const totalAfter = target.reduce((sum, value, band) => sum + value * shape[band]!, 0);
  return {
    method: "spectral-transfer",
    before: round3(clamp(before, 0, 1)),
    after: round3(clamp(after, 0, 1)),
    improvement: before > 0 ? round3((before - after) / before) : 0,
    gapReductionDb: round2(gapReductionDb),
    contextGapReductionDb,
    regionChangeDb: round2(dbRatio(regionAfter, regionBefore)),
    identityChangeDb: round2(dbRatio(totalAfter, totalBefore)),
  };
}

function maskedFraction(victim: number[], masker: number[], weights: number[], bands: number[]): number {
  const total = victim.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || bands.length === 0) return 0;
  let identity = 0;
  let masked = 0;
  bands.forEach((band) => {
    const value = victim[band]!;
    const share = value / total;
    const weight = weights[band] ?? 0;
    identity += share * weight;
    const gap = 10 * Math.log10(Math.max(masker[band]!, 1e-20)) - 10 * Math.log10(Math.max(value, 1e-20));
    masked += share * weight * (1 / (1 + Math.exp(-(gap + 4) / 2.5)));
  });
  return identity > 0 ? masked / identity : 0;
}

/** Mean drop of (competitor − protected) in dB over `bands`, weighted by how contested each band was. */
function weightedGapReduction(victimBefore: number[], maskerBefore: number[], victimAfter: number[], maskerAfter: number[], weights: number[], bands: number[]): number {
  const total = victimBefore.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let weight = 0;
  let change = 0;
  for (const band of bands) {
    const gapBefore = db(maskerBefore[band]!) - db(victimBefore[band]!);
    const gapAfter = db(maskerAfter[band]!) - db(victimAfter[band]!);
    const contested = (victimBefore[band]! / total) * (weights[band] ?? 0) * (1 / (1 + Math.exp(-(gapBefore + 4) / 2.5)));
    weight += contested;
    change += contested * (gapBefore - gapAfter);
  }
  return weight > 0 ? change / weight : 0;
}

function db(power: number): number {
  return 10 * Math.log10(Math.max(power, 1e-20));
}

function range(low: number, high: number): number[] {
  return Array.from({ length: Math.max(0, high - low + 1) }, (_, index) => low + index);
}

/** Bands the filter actually moves by at least a third of its peak effect. */
function regionBands(evidence: EqEvidence, filter: EqFilter): number[] {
  const effect = evidence.bandsHz.map((hz) => Math.abs(chainMagnitudeDb([filter], hz) - (evidence.replaces ? chainMagnitudeDb([evidence.replaces], hz) : 0)));
  const peak = Math.max(...effect, 0);
  if (peak <= 0) return [];
  return effect.map((value, band) => (value >= peak / 3 ? band : -1)).filter((band) => band >= 0);
}

/** The frequency range a proxy check measures for one recommendation. */
export function checkRange(change: EqRecommendation): { lowHz: number; highHz: number } {
  const { evidence } = change;
  const filter = change.processing.filter;
  if (evidence.focus) return { lowHz: evidence.edgesHz[evidence.focus[0]]!, highHz: evidence.edgesHz[evidence.focus[1] + 1]! };
  if (filter.kind === "high-pass") return { lowHz: 20, highHz: filter.frequencyHz };
  if (filter.kind === "low-pass") return { lowHz: filter.frequencyHz, highHz: 20_000 };
  const bands = regionBands(evidence, filter);
  if (bands.length === 0) return { lowHz: filter.frequencyHz / 1.5, highHz: filter.frequencyHz * 1.5 };
  return { lowHz: evidence.edgesHz[bands[0]!]!, highHz: evidence.edgesHz[bands[bands.length - 1]! + 1]! };
}

export interface ProxyCheck {
  id: string;
  regionChangeDb: number;
  identityChangeDb: number;
  seconds: number;
}

/**
 * Folds the playback-proxy measurements into the plan. A filter whose measured effect inside its
 * range is much smaller than predicted (or absent) goes to review with the reason stated.
 */
export function withProxyChecks(plan: EqPlan, checks: ProxyCheck[], failed = 0): EqPlan {
  const byId = new Map(checks.map((check) => [check.id, check]));
  let disagreements = 0;
  const changes = plan.changes.map((change) => {
    const check = byId.get(change.id);
    if (!check || !change.evaluation) return change;
    const predicted = change.evaluation.regionChangeDb;
    const measured = Math.round(check.regionChangeDb * 100) / 100;
    const sameDirection = Math.sign(measured) === Math.sign(predicted) || Math.abs(predicted) < 0.3;
    const agrees = sameDirection && Math.abs(measured - predicted) <= Math.max(1, 0.5 * Math.abs(predicted)) && Math.abs(measured) >= 0.3;
    const evaluation = {
      ...change.evaluation,
      proxy: { regionChangeDb: measured, identityChangeDb: Math.round(check.identityChangeDb * 100) / 100, seconds: Math.round(check.seconds * 10) / 10, agrees },
    };
    if (agrees) return { ...change, evaluation };
    disagreements += 1;
    const reason = `On the playback proxy (${evaluation.proxy.seconds.toFixed(1)} s where the parts overlap) this filter moved ${formatSignedDb(measured)} dB inside its range against a predicted ${formatSignedDb(predicted)} dB, so it waits for a listen before it is applied.`;
    const confidence = Math.max(0.2, Math.round((change.confidence - 0.1) * 100) / 100);
    return {
      ...change,
      evaluation,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      status: change.status === "proposed" ? ("needs-review" as const) : change.status,
      reasons: [...change.reasons.slice(0, 5), reason],
    };
  });
  const checked = checks.filter((check) => byId.has(check.id) && plan.changes.some((change) => change.id === check.id)).length;
  const notes = plan.summary.notes.filter((note) => !note.startsWith("Proxy check:"));
  if (checked > 0 || failed > 0) {
    const agreeing = checked - disagreements;
    notes.push(
      `Proxy check: ${checked} ${checked === 1 ? "filter was" : "filters were"} run over the 48 kHz playback proxies where the parts overlap; ${agreeing} matched the prediction${disagreements > 0 ? `, ${disagreements} went to review` : ""}${failed > 0 ? `, ${failed} could not be checked` : ""}.`,
    );
  }
  const reviewCount = changes.filter((change) => change.status === "needs-review").length;
  return refreshEqTrim({ ...plan, changes, summary: { ...plan.summary, notes: notes.slice(-10), reviewCount } });
}

export interface EqAuditionOptions {
  mode: "current" | "candidate";
  focusId?: string | null;
  focusSide?: "bypassed" | "recommended";
}

export interface EqAudition {
  /** Track-wide filters per track, saved ones first. */
  tracks: Array<{ trackId: string; filters: EqFilter[] }>;
  /** Extra filters inside each section window. */
  regions: Array<{ trackId: string; sectionId: string; startSeconds: number; endSeconds: number; filters: EqFilter[] }>;
  trimDb: number;
  note: string;
}

/**
 * Saved processing plus the included candidate filters. The saved project is not touched.
 * Single-change audition plays the whole mix with only that filter toggled.
 */
export function eqAudition(document: ProjectDocument, plan: EqPlan | null, options: EqAuditionOptions): EqAudition {
  const focusId = options.focusId ?? null;
  const focusSide = options.focusSide ?? "recommended";
  const included = new Set(
    (plan?.changes ?? [])
      .filter((change) => {
        if (focusId === change.id) return focusSide === "recommended";
        if (options.mode === "current") return false;
        return eqRecommendationIncluded(change, "preview");
      })
      .map((change) => change.id),
  );
  const chosen = (plan?.changes ?? []).filter((change) => included.has(change.id));
  const replaced = new Set(chosen.map((change) => change.replacesNodeId).filter((id): id is string => id !== null));
  const tracks = document.tracks.map((track) => ({
    trackId: track.id,
    filters: [
      ...enabledFilters(track.processing.nodes.filter((node) => !replaced.has(node.id))),
      ...chosen.filter((change) => change.trackId === track.id && change.scope.type === "global").map((change) => change.processing.filter),
    ].slice(0, MAX_TRACK_EQ_NODES),
  }));
  const regions: EqAudition["regions"] = [];
  for (const section of document.sections) {
    for (const track of document.tracks) {
      const saved = enabledFilters(sectionEqNodes(document, track.id, section.id).filter((node) => !replaced.has(node.id)));
      const added = chosen
        .filter((change) => change.trackId === track.id && change.scope.type === "section" && change.scope.sectionId === section.id)
        .map((change) => change.processing.filter);
      const filters = [...saved, ...added].slice(0, MAX_SECTION_EQ_NODES);
      if (filters.length === 0) continue;
      regions.push({ trackId: track.id, sectionId: section.id, startSeconds: section.startTime, endSeconds: section.endTime, filters });
    }
  }
  const trimDb = plan && options.mode === "candidate" && !focusId ? trimFor(plan, included) : 0;
  return { tracks, regions, trimDb, note: auditionNote(options, trimDb) };
}

/** The filters that run on one track at `seconds` in an audition, for engines that cannot schedule regions. */
export function eqAuditionChainAt(audition: EqAudition, trackId: string, seconds: number): EqFilter[] {
  const own = audition.tracks.find((item) => item.trackId === trackId)?.filters ?? [];
  const region = audition.regions.find((item) => item.trackId === trackId && seconds >= item.startSeconds && seconds < item.endSeconds);
  return region ? [...own, ...region.filters] : own;
}

/** Writes the chosen filters into the project as processing nodes. One call is one undo step for the caller. */
export function applyEqPlan(document: ProjectDocument, plan: EqPlan, mode: EqApplyMode): ProjectDocument {
  const chosen = plan.changes.filter((change) => (mode === "accepted" ? change.status === "accepted" : eqRecommendationIncluded(change, "all")));
  const included = new Set(chosen.map((change) => change.id));
  const trim = trimFor(plan, included);
  let next: ProjectDocument = document;
  const usedIds = new Set<string>();
  for (const track of document.tracks) for (const node of track.processing.nodes) usedIds.add(node.id);
  for (const row of document.sectionTrackSettings) for (const node of row.processing.nodes) usedIds.add(node.id);
  const nodeFor = (change: EqRecommendation): EqNode => {
    let id = `eq-${fnv1a(`${plan.stateIdentity}:${change.id}`)}`;
    let attempt = 1;
    while (usedIds.has(id)) {
      id = `eq-${fnv1a(`${plan.stateIdentity}:${change.id}:${attempt}`)}`;
      attempt += 1;
    }
    usedIds.add(id);
    return { id, type: "eq", enabled: true, filter: normalizeEqFilter(change.processing.filter), origin: "eq-plan", note: change.reasons[0]!.slice(0, 400) };
  };
  const replace = (nodes: EqNode[], change: EqRecommendation): EqNode[] => {
    const node = nodeFor(change);
    const at = change.replacesNodeId ? nodes.findIndex((item) => item.id === change.replacesNodeId) : -1;
    if (at < 0) return [...nodes, node];
    return nodes.map((item, index) => (index === at ? node : item));
  };
  for (const change of chosen) {
    if (change.scope.type === "global") {
      const nodes = replace(trackEqNodes(next, change.trackId), change).slice(0, MAX_TRACK_EQ_NODES);
      next = { ...next, tracks: next.tracks.map((track) => (track.id === change.trackId ? { ...track, processing: { schemaVersion: 1, nodes } } : track)) };
    } else {
      const sectionId = change.scope.sectionId;
      const nodes = replace(sectionEqNodes(next, change.trackId, sectionId), change).slice(0, MAX_SECTION_EQ_NODES);
      const result = setSectionEqNodes(next, change.trackId, sectionId, nodes);
      if (result.ok) next = result.document;
    }
  }
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

/** Headroom: only boosts can raise a peak. Cuts are not counted, so the estimate never under-reads. */
export function refreshEqTrim(plan: EqPlan): EqPlan {
  const included = new Set(plan.changes.filter((change) => eqRecommendationIncluded(change, "preview")).map((change) => change.id));
  const trim = trimFor(plan, included);
  const reason = trimReason(trim);
  const notes = plan.summary.notes.filter((note) => !note.startsWith("Headroom trim:"));
  if (reason) notes.push(reason);
  return { ...plan, candidateTrim: { gainDb: trim, reason }, summary: { ...plan.summary, notes: notes.slice(0, 10) } };
}

/** Review is about the change a filter makes. Reducing a saved boost is a cut, however much boost is left. */
export function needsReview(filter: EqFilter, confidence: number, replaces: EqFilter | null = null): boolean {
  if (confidence < REVIEW_CONFIDENCE) return true;
  if (filter.q > REVIEW_Q && !isPassFilter(filter.kind)) return true;
  if (isPassFilter(filter.kind)) return false;
  if (replaces && replaces.gainDb > 0 && filter.gainDb <= replaces.gainDb) return filter.gainDb < -REVIEW_CUT_DB;
  return filter.gainDb < -REVIEW_CUT_DB || filter.gainDb > REVIEW_BOOST_DB;
}

export function describeFilter(filter: EqFilter): string {
  const label = EQ_FILTER_LABELS[filter.kind];
  const where = formatHz(filter.frequencyHz);
  if (isPassFilter(filter.kind)) return `${label} at ${where}`;
  return `${label} ${formatSignedDb(filter.gainDb)} dB at ${where}, Q ${filter.q.toFixed(1)}`;
}

/** 82 Hz, 2.4 kHz, 2.43 kHz, 12.5 kHz: as precise as the stored value, no trailing zeros. */
export function formatHz(hz: number): string {
  if (hz >= 1_000) {
    const khz = hz / 1_000;
    return `${Number((khz >= 10 ? khz.toFixed(1) : khz.toFixed(2))).toString()} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

function trimFor(plan: EqPlan, included: Set<string>): number {
  const current = estimateSumPeakDbfs(plan.levels.map((level) => ({ peakDbfs: level.peakDbfs, gainDb: level.gainDb, muted: level.muted })));
  const candidate = estimateSumPeakDbfs(
    plan.levels.map((level) => ({ peakDbfs: level.peakDbfs, gainDb: level.gainDb + peakLift(plan, level, included), muted: level.muted })),
  );
  if (current === null || candidate === null) return 0;
  return headroomTrimDb(current, candidate);
}

/** Largest boost the included filters put on a band where the track has real energy. */
function peakLift(plan: EqPlan, level: EqPlan["levels"][number], included: Set<string>): number {
  const filters = plan.changes.filter((change) => change.trackId === level.trackId && included.has(change.id)).map((change) => change.processing.filter);
  if (filters.length === 0 || level.shares.length === 0) return 0;
  const edges = plan.changes.find((change) => change.evidence.edgesHz.length > 0)?.evidence.edgesHz;
  if (!edges) return 0;
  let lift = 0;
  level.shares.forEach((share, band) => {
    if (share < 0.03) return;
    const gain = 10 * Math.log10(bandPowerGain(filters, edges[band]!, edges[band + 1]!));
    lift = Math.max(lift, gain);
  });
  return lift;
}

function trimReason(trim: number): string | null {
  if (Math.abs(trim) < 0.05) return null;
  return `Headroom trim: ${formatSignedDb(trim)} dB on every stem because the candidate boosts could push the estimated sum peak past the current mix or -1 dBFS. This is a safety trim, not an EQ decision, and it keeps the relative balance.`;
}

function auditionNote(options: EqAuditionOptions, trim: number): string {
  if (options.focusId) {
    return "Single-filter audition plays the whole mix. Only this filter is switched, so the difference you hear is that filter.";
  }
  if (options.mode === "current") return "Current plays the saved mix and its saved EQ.";
  if (Math.abs(trim) < 0.05) return "EQ Candidate plays the saved mix with the included filters added. No loudness match is applied.";
  return `EQ Candidate includes a ${formatSignedDb(trim)} dB safety trim on every stem for headroom. It is not part of any EQ move.`;
}

export function sameFilter(left: EqFilter, right: EqFilter): boolean {
  return left.kind === right.kind && left.frequencyHz === right.frequencyHz && left.gainDb === right.gainDb && left.q === right.q;
}

export function labelConfidence(value: number): "high" | "medium" | "low" {
  return confidenceLabel(value);
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function dbRatio(after: number, before: number): number {
  if (before <= 0 || after <= 0) return 0;
  return 10 * Math.log10(after / before);
}

function clampGain(value: number): number {
  return Math.round(Math.min(GAIN_DB_MAX, Math.max(GAIN_DB_MIN, value)) * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
