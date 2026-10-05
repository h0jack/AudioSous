import { ANALYSIS_ENGINE_VERSION } from "@audiosous/analysis-contract";
import {
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  emptyProcessingGraph,
  sectionSettingInUse,
  withUpdatedAt,
  type ProjectDocument,
  type TrackSectionState,
} from "@audiosous/project-model";
import { z } from "zod";

export const MIX_PLAN_VERSION = 1;
export const PLANNER_VERSION = "3.1.0";
export const HEADROOM_CEILING_DBFS = -1;
export const HEADROOM_TRIM_LIMIT_DB = 6;
export const REVIEW_GAIN_DB = 6;

export const BALANCE_STRENGTHS = ["conservative", "normal", "strong"] as const;
export type BalanceStrength = (typeof BALANCE_STRENGTHS)[number];

export interface AutoBalanceSettings {
  style: "balanced";
  strength: BalanceStrength;
}

export const DEFAULT_AUTOBALANCE_SETTINGS: AutoBalanceSettings = {
  style: "balanced",
  strength: "normal",
};

export interface StrengthLimits {
  maxDb: number;
  deadbandDb: number;
  primaryMix: number;
  supportMix: number;
  supportGapDb: number;
  backgroundGapDb: number;
  focalLiftDb: number;
  sectionResidualDb: number;
  bassUnderDb: number;
  /** Gap between two primary elements that is left alone; full correction at twice this. */
  primaryToleranceDb: number;
  /**
   * How far a primary element may read above a kick anchor before any cut; full correction at twice this.
   * Integrated loudness reads sustained parts several LU hotter than a transient kick that sounds as loud.
   */
  overKickToleranceDb: number;
}

export const STRENGTH_LIMITS: Record<BalanceStrength, StrengthLimits> = {
  conservative: {
    maxDb: 2,
    deadbandDb: 0.5,
    primaryMix: 0.55,
    supportMix: 0.4,
    supportGapDb: 3.2,
    backgroundGapDb: 10,
    focalLiftDb: 0.6,
    sectionResidualDb: 1.2,
    bassUnderDb: 0.6,
    primaryToleranceDb: 2.5,
    overKickToleranceDb: 7,
  },
  normal: {
    maxDb: 4,
    deadbandDb: 0.4,
    primaryMix: 0.8,
    supportMix: 0.5,
    supportGapDb: 2.5,
    backgroundGapDb: 9,
    focalLiftDb: 1,
    sectionResidualDb: 1,
    bassUnderDb: 0.5,
    primaryToleranceDb: 2,
    overKickToleranceDb: 6,
  },
  strong: {
    maxDb: 6,
    deadbandDb: 0.3,
    primaryMix: 0.95,
    supportMix: 0.65,
    supportGapDb: 2,
    backgroundGapDb: 8,
    focalLiftDb: 1.4,
    sectionResidualDb: 0.8,
    bassUnderDb: 0.4,
    primaryToleranceDb: 1.5,
    overKickToleranceDb: 5,
  },
};

const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("section"), sectionId: z.string().min(1) }),
]);

export type RecommendationScope = z.infer<typeof scopeSchema>;

export const recommendationStatusSchema = z.enum(["proposed", "accepted", "rejected", "needs-review"]);
export type RecommendationStatus = z.infer<typeof recommendationStatusSchema>;

export const gainRecommendationSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  scope: scopeSchema,
  currentGainDb: z.number().finite(),
  recommendedGainDb: z.number().finite(),
  deltaDb: z.number().finite(),
  /** Section rows store the extra gain on top of the planned global gain. */
  offsetFromGlobalDb: z.number().finite(),
  confidence: z.number().finite().min(0).max(1),
  confidenceLabel: z.enum(["high", "medium", "low"]),
  status: recommendationStatusSchema,
  edited: z.boolean(),
  reasons: z.array(z.string().min(1).max(500)).min(1).max(6),
});

export type GainRecommendation = z.infer<typeof gainRecommendationSchema>;

export const mixPlanSchema = z.object({
  planVersion: z.literal(MIX_PLAN_VERSION),
  plannerVersion: z.literal(PLANNER_VERSION),
  kind: z.literal("auto-balance"),
  createdAt: z.string().min(1),
  projectId: z.string().min(1),
  sourceAnalysisVersion: z.string().min(1),
  settings: z.object({
    style: z.literal("balanced"),
    strength: z.enum(BALANCE_STRENGTHS),
  }),
  stateIdentity: z.string().min(1),
  summary: z.object({
    goal: z.literal("balanced"),
    confidence: z.number().finite().min(0).max(1),
    headline: z.string().min(1),
    notes: z.array(z.string()).max(8),
    changeCount: z.number().int().nonnegative(),
    reviewCount: z.number().int().nonnegative(),
  }),
  anchor: z.object({
    trackIds: z.array(z.string()),
    label: z.string(),
    reason: z.string(),
  }),
  trackChanges: z.array(gainRecommendationSchema).max(256),
  candidateTrim: z.object({
    gainDb: z.number().finite(),
    reason: z.string().nullable(),
  }),
  levels: z.array(
    z.object({
      trackId: z.string().min(1),
      peakDbfs: z.number().finite().nullable(),
      muted: z.boolean(),
      gainDb: z.number().finite(),
    }),
  ),
});

export type MixPlan = z.infer<typeof mixPlanSchema>;

export interface SourceFingerprint {
  trackId: string;
  fileSizeBytes: number;
  modifiedAtNs: string;
}

export function confidenceLabel(value: number): "high" | "medium" | "low" {
  if (value >= 0.8) return "high";
  if (value >= 0.55) return "medium";
  return "low";
}

export function roundDb(value: number): number {
  return Math.round(value * 10) / 10;
}

export function clampGainDb(value: number): number {
  return roundDb(Math.min(GAIN_DB_MAX, Math.max(GAIN_DB_MIN, value)));
}

export function formatSignedDb(value: number): string {
  const rounded = roundDb(value);
  const text = rounded.toFixed(1);
  return rounded > 0 ? `+${text}` : text;
}

export function recommendationId(trackId: string, scope: RecommendationScope): string {
  return scope.type === "global" ? `${trackId}::global` : `${trackId}::section::${scope.sectionId}`;
}

export function planStateIdentity(
  document: ProjectDocument,
  settings: AutoBalanceSettings,
  fingerprints: SourceFingerprint[] = [],
): string {
  const files = new Map(fingerprints.map((file) => [file.trackId, file]));
  const payload = {
    projectId: document.project.id,
    analysis: ANALYSIS_ENGINE_VERSION,
    settings,
    tracks: document.tracks.map((track) => {
      const file = files.get(track.id);
      return {
        id: track.id,
        role: track.role,
        gainDb: track.gainDb,
        muted: track.muted,
        duration: track.metadata.durationSeconds,
        fileSize: file?.fileSizeBytes ?? track.metadata.fileSizeBytes,
        modified: file?.modifiedAtNs ?? "",
      };
    }),
    sections: document.sections.map((section) => ({
      id: section.id,
      start: section.startTime,
      end: section.endTime,
      type: section.type,
      intent: section.userIntent,
    })),
    settingsRows: [...document.sectionTrackSettings]
      .sort((left, right) => `${left.trackId}:${left.sectionId}`.localeCompare(`${right.trackId}:${right.sectionId}`))
      .map((row) => ({
        trackId: row.trackId,
        sectionId: row.sectionId,
        prominence: row.prominence,
        intent: row.userIntent,
        gainDb: row.overrides.gainDb,
      })),
  };
  return fnv1a(JSON.stringify(payload));
}

export function planIsStale(
  plan: MixPlan,
  document: ProjectDocument,
  fingerprints: SourceFingerprint[] = [],
  settings: AutoBalanceSettings = plan.settings,
): boolean {
  return plan.projectId !== document.project.id || plan.stateIdentity !== planStateIdentity(document, settings, fingerprints);
}

export type ApplyMode = "all" | "accepted";

export function recommendationIncluded(change: GainRecommendation, mode: ApplyMode | "preview"): boolean {
  if (change.status === "rejected") return false;
  if (mode === "accepted") return change.status === "accepted";
  if (change.status === "needs-review") return false;
  return change.status === "proposed" || change.status === "accepted";
}

export interface AuditionOptions {
  mode: "current" | "candidate";
  focusId?: string | null;
  focusSide?: "original" | "recommended";
}

export interface AuditionRegion {
  trackId: string;
  sectionId: string;
  startSeconds: number;
  endSeconds: number;
  gainDb: number;
}

export interface AuditionMix {
  tracks: Array<{ trackId: string; gainDb: number }>;
  regions: AuditionRegion[];
  trimDb: number;
  trimApplied: boolean;
  note: string;
}

export function auditionMix(document: ProjectDocument, plan: MixPlan, options: AuditionOptions): AuditionMix {
  const focusId = options.focusId ?? null;
  const focusSide = options.focusSide ?? "recommended";
  const trimApplied = options.mode === "candidate";
  const included = new Set(
    plan.trackChanges.filter((change) => includedForAudition(change, options.mode, focusId, focusSide)).map((change) => change.id),
  );
  const trim = trimApplied ? trimFor(document, plan, included) : 0;
  const tracks = document.tracks.map((track) => {
    const global = plan.trackChanges.find((change) => change.trackId === track.id && change.scope.type === "global");
    const useGlobal = global !== undefined && included.has(global.id);
    const gain = (useGlobal ? global.recommendedGainDb : track.gainDb) + trim;
    return { trackId: track.id, gainDb: clampGainDb(gain) };
  });
  const gainByTrack = new Map(tracks.map((track) => [track.trackId, track.gainDb]));
  const regions: AuditionRegion[] = [];
  for (const change of plan.trackChanges) {
    if (change.scope.type !== "section") continue;
    const sectionId = change.scope.sectionId;
    if (!included.has(change.id)) continue;
    const section = document.sections.find((item) => item.id === sectionId);
    if (!section) continue;
    const base = (gainByTrack.get(change.trackId) ?? 0) - trim;
    regions.push({
      trackId: change.trackId,
      sectionId: section.id,
      startSeconds: section.startTime,
      endSeconds: section.endTime,
      gainDb: clampGainDb(base + change.offsetFromGlobalDb + trim),
    });
  }
  return {
    tracks,
    regions,
    trimDb: trim,
    trimApplied,
    note: auditionNote(trimApplied, trim),
  };
}

export function auditionGainAt(mix: AuditionMix, trackId: string, timeSeconds: number): number {
  const region = mix.regions.find(
    (item) => item.trackId === trackId && timeSeconds >= item.startSeconds && timeSeconds < item.endSeconds,
  );
  if (region) return region.gainDb;
  return mix.tracks.find((track) => track.trackId === trackId)?.gainDb ?? 0;
}

export function applyMixPlan(document: ProjectDocument, plan: MixPlan, mode: ApplyMode): ProjectDocument {
  const chosen = mixForMode(document, plan, mode);
  const gainByTrack = new Map(chosen.tracks.map((track) => [track.trackId, track.gainDb]));
  const regionByKey = new Map(chosen.regions.map((region) => [`${region.trackId}:${region.sectionId}`, region.gainDb]));
  const tracks = document.tracks.map((track) => ({
    ...track,
    gainDb: gainByTrack.get(track.id) ?? track.gainDb,
  }));
  const sectionTrackSettings = document.sectionTrackSettings.map((setting) => {
    const key = `${setting.trackId}:${setting.sectionId}`;
    if (!regionByKey.has(key)) {
      if (setting.overrides.gainDb === null || chosen.trimDb === 0 || !chosen.trimApplied) return setting;
      return {
        ...setting,
        overrides: { ...setting.overrides, gainDb: clampGainDb(setting.overrides.gainDb + chosen.trimDb) },
      };
    }
    const gainDb = regionByKey.get(key) ?? null;
    const trackGain = gainByTrack.get(setting.trackId) ?? 0;
    return {
      ...setting,
      overrides: {
        ...setting.overrides,
        gainDb: gainDb !== null && Math.abs(gainDb - trackGain) < 0.05 ? null : gainDb,
      },
    };
  });
  const seen = new Set(sectionTrackSettings.map((setting) => `${setting.trackId}:${setting.sectionId}`));
  for (const region of chosen.regions) {
    const key = `${region.trackId}:${region.sectionId}`;
    if (seen.has(key)) continue;
    const trackGain = gainByTrack.get(region.trackId) ?? 0;
    if (Math.abs(region.gainDb - trackGain) < 0.05) continue;
    sectionTrackSettings.push(sectionSetting(document, region.trackId, region.sectionId, region.gainDb));
  }
  const kept = sectionTrackSettings.filter(sectionSettingInUse);
  return withUpdatedAt({
    ...document,
    tracks,
    sectionTrackSettings: kept,
  });
}

export function setRecommendationStatus(plan: MixPlan, id: string, status: RecommendationStatus): MixPlan {
  return refreshPlanTrim({
    ...plan,
    trackChanges: plan.trackChanges.map((change) => (change.id === id ? { ...change, status } : change)),
  });
}

export function editRecommendation(plan: MixPlan, id: string, recommendedGainDb: number): MixPlan {
  const next = roundDb(recommendedGainDb);
  const trackChanges = plan.trackChanges.map((change) => {
    if (change.id !== id) return change;
    const delta = roundDb(next - change.currentGainDb);
    const offset = change.scope.type === "section" ? roundDb(next - plannedGlobalGain(plan, change.trackId, change.currentGainDb)) : delta;
    return {
      ...change,
      recommendedGainDb: next,
      deltaDb: delta,
      offsetFromGlobalDb: offset,
      edited: true,
    };
  });
  const adjusted = trackChanges.map((change) => {
    if (change.scope.type !== "section") return change;
    const global = trackChanges.find((item) => item.trackId === change.trackId && item.scope.type === "global");
    if (!global || global.id === id) {
      const base = global ? global.recommendedGainDb : plannedGlobalGain(plan, change.trackId, change.currentGainDb);
      if (change.id === id) return change;
      const recommended = roundDb(base + change.offsetFromGlobalDb);
      return { ...change, recommendedGainDb: recommended, deltaDb: roundDb(recommended - change.currentGainDb) };
    }
    if (change.id === id) return change;
    const recommended = roundDb(global.recommendedGainDb + change.offsetFromGlobalDb);
    return { ...change, recommendedGainDb: recommended, deltaDb: roundDb(recommended - change.currentGainDb) };
  });
  return refreshPlanTrim({ ...plan, trackChanges: adjusted });
}

export function headroomTrimDb(currentEstimate: number, candidateEstimate: number): number {
  if (!Number.isFinite(currentEstimate) || !Number.isFinite(candidateEstimate)) return 0;
  const ceiling = currentEstimate > HEADROOM_CEILING_DBFS ? currentEstimate : HEADROOM_CEILING_DBFS;
  if (candidateEstimate <= ceiling + 0.05) return 0;
  return roundDb(Math.max(-HEADROOM_TRIM_LIMIT_DB, ceiling - candidateEstimate));
}

export function estimateSumPeakDbfs(tracks: Array<{ peakDbfs: number | null; gainDb: number; muted: boolean }>): number | null {
  let power = 0;
  let any = false;
  for (const track of tracks) {
    if (track.muted || track.peakDbfs === null) continue;
    power += 10 ** ((track.peakDbfs + track.gainDb) / 10);
    any = true;
  }
  if (!any || power <= 0) return null;
  return 10 * Math.log10(power) + 1;
}

export function refreshPlanTrim(plan: MixPlan): MixPlan {
  const included = new Set(plan.trackChanges.filter((change) => recommendationIncluded(change, "preview")).map((change) => change.id));
  const trim = trimFromLevels(plan, included);
  const reason = trimReason(trim);
  const notes = plan.summary.notes.filter((note) => !note.startsWith("Headroom trim:"));
  if (reason) notes.push(reason);
  return {
    ...plan,
    candidateTrim: { gainDb: trim, reason },
    summary: { ...plan.summary, notes },
  };
}

function trimFor(document: ProjectDocument, plan: MixPlan, included: Set<string>): number {
  const levels =
    plan.levels.length > 0
      ? plan.levels
      : document.tracks.map((track) => ({ trackId: track.id, peakDbfs: null, muted: track.muted, gainDb: track.gainDb }));
  return trimFromLevels({ ...plan, levels }, included);
}

function trimFromLevels(plan: Pick<MixPlan, "levels" | "trackChanges">, included: Set<string>): number {
  const current = estimateSumPeakDbfs(plan.levels.map((level) => ({ peakDbfs: level.peakDbfs, gainDb: level.gainDb, muted: level.muted })));
  const candidate = estimateSumPeakDbfs(
    plan.levels.map((level) => ({
      peakDbfs: level.peakDbfs,
      gainDb: level.gainDb + candidateLift(plan.trackChanges, level.trackId, included),
      muted: level.muted,
    })),
  );
  if (current === null || candidate === null) return 0;
  return headroomTrimDb(current, candidate);
}

function candidateLift(changes: MixPlan["trackChanges"], trackId: string, included: Set<string>): number {
  const global = changes.find((change) => change.trackId === trackId && change.scope.type === "global" && included.has(change.id));
  const lift = changes
    .filter((change) => change.trackId === trackId && change.scope.type === "section" && included.has(change.id))
    .reduce((max, change) => Math.max(max, change.offsetFromGlobalDb), 0);
  return (global?.deltaDb ?? 0) + Math.max(0, lift);
}

function mixForMode(document: ProjectDocument, plan: MixPlan, mode: ApplyMode): AuditionMix {
  if (mode === "all") return auditionMix(document, plan, { mode: "candidate" });
  const masked: MixPlan = {
    ...plan,
    trackChanges: plan.trackChanges.map((change) =>
      change.status === "accepted" ? { ...change, status: "proposed" } : { ...change, status: "rejected" },
    ),
  };
  return auditionMix(document, masked, { mode: "candidate" });
}

function trimReason(trim: number): string | null {
  if (Math.abs(trim) < 0.05) return null;
  return `Headroom trim: ${formatSignedDb(trim)} dB on every stem so the estimated sum peak stays at the current mix or under ${HEADROOM_CEILING_DBFS} dBFS. The same trim is added to every track, so the relative balance stays. This is not a loudness target.`;
}

function auditionNote(trimApplied: boolean, trim: number): string {
  if (!trimApplied) {
    return "Single-track audition compares that stem in the current mix. The plan's headroom trim stays off, so the difference is only the recommendation.";
  }
  if (Math.abs(trim) < 0.05) {
    return "Whole-plan preview plays the candidate against the current mix. No loudness match is applied, so the balance changes stay audible.";
  }
  return `Whole-plan preview includes a ${formatSignedDb(trim)} dB trim on every stem. That trim keeps the estimated sum from getting hotter than the current mix or ${HEADROOM_CEILING_DBFS} dBFS. It does not undo the relative changes, and it is not a mastering loudness target.`;
}

function includedForAudition(
  change: GainRecommendation,
  mode: "current" | "candidate",
  focusId: string | null,
  focusSide: "original" | "recommended",
): boolean {
  if (focusId === change.id) return focusSide === "recommended";
  if (mode === "current") return false;
  return recommendationIncluded(change, "preview");
}

function plannedGlobalGain(plan: MixPlan, trackId: string, fallback: number): number {
  const global = plan.trackChanges.find((change) => change.trackId === trackId && change.scope.type === "global");
  return global?.recommendedGainDb ?? fallback;
}

function sectionSetting(document: ProjectDocument, trackId: string, sectionId: string, gainDb: number): TrackSectionState {
  const existing = document.sectionTrackSettings.find((setting) => setting.trackId === trackId && setting.sectionId === sectionId);
  return {
    trackId,
    sectionId,
    userIntent: existing?.userIntent ?? null,
    prominence: existing?.prominence ?? null,
    overrides: { gainDb, pan: existing?.overrides.pan ?? null },
    processing: existing?.processing ?? emptyProcessingGraph(),
  };
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
