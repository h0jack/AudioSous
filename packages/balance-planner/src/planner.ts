import { ANALYSIS_ENGINE_VERSION, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import {
  TRACK_ROLE_LABELS,
  type ProjectDocument,
  type SongSection,
  type Track,
  type TrackRole,
} from "@audiosous/project-model";
import { balanceMetrics, lowBandOverlap, type BalanceMetrics } from "./metrics";
import {
  DEFAULT_AUTOBALANCE_SETTINGS,
  PLANNER_VERSION,
  REVIEW_GAIN_DB,
  STRENGTH_LIMITS,
  confidenceLabel,
  formatSignedDb,
  mixPlanSchema,
  planStateIdentity,
  recommendationId,
  refreshPlanTrim,
  roundDb,
  type AutoBalanceSettings,
  type GainRecommendation,
  type MixPlan,
  type RecommendationScope,
  type SourceFingerprint,
  type StrengthLimits,
} from "./plan";

export interface TrackMeasurements {
  track: TrackFileMeasurement | null;
  sections?: Record<string, TrackFileMeasurement | null>;
}

export interface PlanBalanceInput {
  document: ProjectDocument;
  measurements: Record<string, TrackMeasurements | undefined>;
  settings?: Partial<AutoBalanceSettings>;
  fingerprints?: SourceFingerprint[];
  now?: string;
}

type Tier = "primary" | "focal" | "supporting" | "background" | "unknown";

const ROLE_TIER: Record<TrackRole, Tier> = {
  kick: "primary",
  bass: "primary",
  lead: "primary",
  vocal: "primary",
  drums: "primary",
  "snare-clap": "supporting",
  "hi-hat": "supporting",
  percussion: "supporting",
  synth: "supporting",
  pad: "supporting",
  keys: "supporting",
  guitar: "supporting",
  "backing-vocal": "supporting",
  brass: "supporting",
  strings: "supporting",
  fx: "background",
  atmosphere: "background",
  other: "unknown",
};

const ANCHOR_ORDER: TrackRole[] = ["kick", "vocal", "lead", "bass", "drums"];

interface ScopeRead {
  section: SongSection | null;
  metrics: BalanceMetrics | null;
  tier: Tier;
  defaultTier: Tier;
  explicit: boolean;
  audible: number | null;
  currentGainDb: number;
}

interface ScopeWish {
  read: ScopeRead;
  delta: number;
  raw: number;
  overCap: boolean;
  reasons: string[];
  confidence: number;
  referenceName: string;
  gapDb: number;
}

interface AnchorChoice {
  trackIds: string[];
  label: string;
  reason: string;
  level: number | null;
}

/**
 * Deterministic gain-only balance plan.
 * Measurements stay measurements. This function only decides what they imply.
 */
export function planBalance(input: PlanBalanceInput): MixPlan {
  const settings: AutoBalanceSettings = {
    style: "balanced",
    strength: input.settings?.strength ?? DEFAULT_AUTOBALANCE_SETTINGS.strength,
  };
  const limits = STRENGTH_LIMITS[settings.strength];
  const document = input.document;
  const fingerprints = input.fingerprints ?? [];
  const identity = planStateIdentity(document, settings, fingerprints);
  const anchor = chooseAnchor(document, input.measurements);
  const unknownRoles = document.tracks.filter((track) => track.role === "other" && !track.customLabel).length;
  const unmeasured = document.tracks.filter((track) => !input.measurements[track.id]?.track).length;
  const changes: GainRecommendation[] = [];
  if (anchor.level !== null) {
    for (const track of document.tracks) {
      if (track.muted) continue;
      changes.push(...planTrack(document, track, input.measurements, anchor, limits));
    }
  }
  const ordered = orderChanges(document, changes);
  const confidence = overallConfidence(ordered, anchor, unknownRoles, unmeasured);
  const summary = summarize(ordered, anchor, unknownRoles, unmeasured, confidence);
  const draft: MixPlan = {
    planVersion: 1,
    plannerVersion: PLANNER_VERSION,
    kind: "auto-balance",
    createdAt: input.now ?? new Date().toISOString(),
    projectId: document.project.id,
    sourceAnalysisVersion: ANALYSIS_ENGINE_VERSION,
    settings,
    stateIdentity: identity,
    summary,
    anchor: { trackIds: anchor.trackIds, label: anchor.label, reason: anchor.reason },
    trackChanges: ordered,
    candidateTrim: { gainDb: 0, reason: null },
    levels: document.tracks.map((track) => ({
      trackId: track.id,
      peakDbfs: input.measurements[track.id]?.track?.levels.peakDbfs ?? null,
      muted: track.muted,
      gainDb: track.gainDb,
    })),
  };
  const trimmed = refreshPlanTrim(draft);
  return mixPlanSchema.parse(trimmed);
}

function planTrack(
  document: ProjectDocument,
  track: Track,
  measurements: Record<string, TrackMeasurements | undefined>,
  anchor: AnchorChoice,
  limits: StrengthLimits,
): GainRecommendation[] {
  const bag = measurements[track.id];
  const defaultTier = defaultTierFor(track, document.tracks);
  const sections = document.sections;
  const reads = sections.length
    ? sections.map((section) => readScope(document, track, bag, section, defaultTier))
    : [readScope(document, track, bag, null, defaultTier)];
  const active = reads.filter((read) => read.audible !== null && (read.metrics?.activeSeconds ?? 0) >= 0.45 && (read.metrics?.activePercent ?? 0) >= 8);
  if (active.length === 0) return [];
  const wishes = active.map((read) => wishFor(document, track, read, measurements, anchor, limits, defaultTier));
  const corrected = correctOnce(track, wishes, anchor, limits);
  return regularize(document, track, corrected, limits);
}

function readScope(
  document: ProjectDocument,
  track: Track,
  bag: TrackMeasurements | undefined,
  section: SongSection | null,
  defaultTier: Tier,
): ScopeRead {
  const setting = section
    ? document.sectionTrackSettings.find((item) => item.trackId === track.id && item.sectionId === section.id)
    : undefined;
  const metrics = section
    ? balanceMetrics(bag?.sections?.[section.id] ?? null) ?? balanceMetrics(bag?.track ?? null, { start: section.startTime, end: section.endTime })
    : balanceMetrics(bag?.track ?? null);
  const intentTier = tierFromIntent(setting?.userIntent ?? null);
  const explicit = setting?.prominence != null || intentTier != null;
  const tier = setting?.prominence ?? intentTier ?? defaultTier;
  const currentGainDb = section ? (setting?.overrides.gainDb ?? track.gainDb) : track.gainDb;
  const audible = metrics?.activeRmsDbfs === null || metrics?.activeRmsDbfs === undefined ? null : metrics.activeRmsDbfs + currentGainDb;
  return { section, metrics, tier, defaultTier, explicit, audible, currentGainDb };
}

function wishFor(
  document: ProjectDocument,
  track: Track,
  read: ScopeRead,
  measurements: Record<string, TrackMeasurements | undefined>,
  anchor: AnchorChoice,
  limits: StrengthLimits,
  defaultTier: Tier,
): ScopeWish {
  const audible = read.audible ?? 0;
  const reference = referenceLevel(document, track, read, measurements, anchor);
  const referenceName = reference.name;
  const gapDb = roundDb(reference.level - audible);
  let raw = 0;
  let overlapNote: string | null = null;
  const isAnchor = anchor.trackIds.includes(track.id) && read.tier === "primary";
  if (read.tier === "unknown" || read.audible === null || isAnchor) {
    raw = 0;
  } else if (read.tier === "background" || read.tier === "supporting") {
    const gap = read.tier === "background" ? limits.backgroundGapDb : limits.supportGapDb;
    const ceiling = reference.level - gap;
    if (audible > ceiling) raw = -((audible - ceiling) * limits.supportMix);
    if ((read.metrics?.activePercent ?? 100) < 15 && raw > 0) raw = 0;
  } else if (read.tier === "focal") {
    const target = reference.level + limits.focalLiftDb;
    const error = target - audible;
    raw = error > 0 ? error * limits.primaryMix : error < -3 ? (error + 3) * limits.primaryMix : 0;
  } else if (track.role === "bass" && reference.role === "kick") {
    let target = reference.level - limits.bassUnderDb;
    const overlap = lowBandOverlap(
      measurements[track.id]?.track?.bandEnergy,
      reference.trackId ? measurements[reference.trackId]?.track?.bandEnergy : undefined,
    );
    if (overlap > 0.45 && audible > reference.level) {
      target -= 0.4;
      overlapNote = `Reducing ${track.name} slightly may improve the ${referenceName}/${track.name} hierarchy where they share low-frequency energy.`;
    }
    raw = (target - audible) * limits.primaryMix * 0.7;
  } else {
    raw = (reference.level - audible) * limits.primaryMix;
  }
  if ((track.role === "fx" || track.role === "atmosphere" || read.tier === "background") && raw > 0) raw = 0;
  if ((read.metrics?.activePercent ?? 100) < 12 && raw > 0 && read.tier !== "focal") raw = 0;
  const overCap = Math.abs(raw) > REVIEW_GAIN_DB;
  const capped = clamp(raw, -limits.maxDb, limits.maxDb);
  const delta = Math.abs(capped) < limits.deadbandDb ? 0 : roundDb(capped);
  const reasons = reasonLines(track, read, referenceName, gapDb, delta, overCap, overlapNote, defaultTier);
  return {
    read,
    delta,
    raw: roundDb(raw),
    overCap,
    reasons,
    confidence: confidenceFor(track, read, overCap),
    referenceName,
    gapDb,
  };
}

function correctOnce(track: Track, wishes: ScopeWish[], anchor: AnchorChoice, limits: StrengthLimits): ScopeWish[] {
  return wishes.map((wish) => {
    if (wish.read.tier !== "supporting" && wish.read.tier !== "background") return wish;
    if (wish.read.audible === null || anchor.level === null) return wish;
    const simulated = wish.read.audible + wish.delta;
    const limit = anchor.level - 0.8;
    if (simulated <= limit) return wish;
    const room = limits.maxDb - Math.abs(wish.delta);
    if (room < 0.4 || wish.delta > 0) return wish;
    const extra = Math.min(room, simulated - limit, 1);
    const delta = roundDb(wish.delta - extra);
    if (Math.abs(delta) < limits.deadbandDb) return wish;
    const reasons = [
      ...wish.reasons,
      `A follow-up check still had ${track.name} above the primary level, so the reduction was deepened slightly.`,
    ];
    return { ...wish, delta, reasons: reasons.slice(0, 6), overCap: wish.overCap || Math.abs(wish.raw) > REVIEW_GAIN_DB };
  });
}

function regularize(
  document: ProjectDocument,
  track: Track,
  wishes: ScopeWish[],
  limits: StrengthLimits,
): GainRecommendation[] {
  if (wishes.length === 0) return [];
  const specials = wishes.filter((wish) => wish.read.section && wish.read.tier !== wish.read.defaultTier);
  const regulars = wishes.filter((wish) => !specials.includes(wish));
  const medianSource = regulars.length > 0 ? regulars : [];
  let globalDelta =
    medianSource.length > 0
      ? roundDb(weightedMedian(medianSource.map((wish) => ({ value: wish.delta, weight: wish.read.metrics?.activeSeconds ?? 1 }))))
      : 0;
  if (Math.abs(globalDelta) < limits.deadbandDb) globalDelta = 0;
  const plannedGlobal = roundDb(track.gainDb + globalDelta);
  const recs: GainRecommendation[] = [];
  if (globalDelta !== 0) {
    const sample = closest(regulars.length ? regulars : wishes, globalDelta);
    recs.push(toRecommendation(track, sample, { type: "global" }, plannedGlobal, globalDelta, document.sections.length > 1));
  }
  for (const wish of [...specials, ...regulars]) {
    if (!wish.read.section) continue;
    const absolute = roundDb(wish.read.currentGainDb + wish.delta);
    const offset = roundDb(absolute - plannedGlobal);
    const special = wish.read.tier !== wish.read.defaultTier;
    if (special) {
      if (Math.abs(offset) < limits.deadbandDb) continue;
    } else if (Math.abs(offset) < limits.sectionResidualDb) {
      continue;
    } else {
      const others = regulars.filter((item) => item !== wish);
      const spread = others.length === 0 ? 0 : Math.max(...others.map((item) => item.delta)) - Math.min(...others.map((item) => item.delta));
      if (others.length > 0 && spread > 1.5) continue;
    }
    recs.push(toRecommendation(track, wish, { type: "section", sectionId: wish.read.section.id }, roundDb(plannedGlobal + offset), offset, false));
  }
  return recs;
}

function toRecommendation(
  track: Track,
  wish: ScopeWish,
  scope: RecommendationScope,
  recommended: number,
  offset: number,
  acrossSections: boolean,
): GainRecommendation {
  const current = scope.type === "global" ? roundDb(track.gainDb) : roundDb(wish.read.currentGainDb);
  const recommendedGainDb = roundDb(recommended);
  const status = wish.overCap || wish.confidence < 0.5 ? "needs-review" : "proposed";
  let reasons = wish.reasons.map((reason) => (scope.type === "global" && wish.read.section ? reason.replace(` in ${wish.read.section.name}`, "") : reason));
  if (acrossSections) reasons = reasons.map((reason) => reason.replace(" because ", " across most sections because "));
  return {
    id: recommendationId(track.id, scope),
    trackId: track.id,
    scope,
    currentGainDb: current,
    recommendedGainDb,
    deltaDb: roundDb(recommendedGainDb - current),
    offsetFromGlobalDb: scope.type === "section" ? offset : roundDb(recommendedGainDb - track.gainDb),
    confidence: wish.confidence,
    confidenceLabel: confidenceLabel(wish.confidence),
    status,
    edited: false,
    reasons: reasons.length > 0 ? reasons : [`${track.name} stays at its current gain.`],
  };
}

function referenceLevel(
  document: ProjectDocument,
  track: Track,
  read: ScopeRead,
  measurements: Record<string, TrackMeasurements | undefined>,
  anchor: AnchorChoice,
): { level: number; name: string; role: TrackRole | null; trackId: string | null } {
  const peers = document.tracks
    .filter((peer) => peer.id !== track.id && !peer.muted)
    .map((peer) => {
      const peerRead = readScope(document, peer, measurements[peer.id], read.section, defaultTierFor(peer, document.tracks));
      return { peer, peerRead };
    })
    .filter((item) => item.peerRead.audible !== null && (item.peerRead.tier === "primary" || item.peerRead.tier === "focal"));
  const loudest = peers.sort((left, right) => (right.peerRead.audible ?? -200) - (left.peerRead.audible ?? -200))[0];
  if (loudest?.peerRead.audible !== null && loudest?.peerRead.audible !== undefined) {
    return { level: loudest.peerRead.audible, name: loudest.peer.name, role: loudest.peer.role, trackId: loudest.peer.id };
  }
  const anchorTrack = document.tracks.find((item) => item.id === anchor.trackIds[0]);
  return {
    level: anchor.level ?? read.audible ?? 0,
    name: anchorTrack?.name ?? anchor.label,
    role: anchorTrack?.role ?? null,
    trackId: anchorTrack?.id ?? null,
  };
}

function chooseAnchor(document: ProjectDocument, measurements: Record<string, TrackMeasurements | undefined>): AnchorChoice {
  const ranked = document.tracks
    .filter((track) => !track.muted)
    .map((track) => {
      const metrics = balanceMetrics(measurements[track.id]?.track ?? null);
      const tier = defaultTierFor(track, document.tracks);
      return { track, metrics, tier };
    })
    .filter((item) => item.tier === "primary" && item.metrics?.activeRmsDbfs !== null && (item.metrics?.activePercent ?? 0) >= 35);
  const preferred = ANCHOR_ORDER.map((role) => ranked.find((item) => item.track.role === role)).find((item) => item !== undefined);
  const chosen = preferred ?? ranked.sort((left, right) => (right.metrics?.activePercent ?? 0) - (left.metrics?.activePercent ?? 0))[0];
  if (!chosen || chosen.metrics?.activeRmsDbfs === null || chosen.metrics?.activeRmsDbfs === undefined) {
    return {
      trackIds: [],
      label: "None",
      reason: "No Primary element is active enough to anchor the balance. Levels were left unchanged.",
      level: null,
    };
  }
  const level = chosen.metrics.activeRmsDbfs + chosen.track.gainDb;
  return {
    trackIds: [chosen.track.id],
    label: chosen.track.name,
    reason: `${chosen.track.name} is marked ${TRACK_ROLE_LABELS[chosen.track.role]}, active through most of its file, and is the clearest structural anchor.`,
    level,
  };
}

function defaultTierFor(track: Track, tracks: Track[]): Tier {
  if (track.role === "drums" && tracks.some((item) => item.role === "kick" && item.id !== track.id)) return "supporting";
  return ROLE_TIER[track.role];
}

function tierFromIntent(intent: string | null): Tier | null {
  if (!intent) return null;
  const value = intent.toLowerCase();
  if (/\b(focal|feature|featured|up front|foreground|take the lead|solo)\b/.test(value)) return "focal";
  if (/\b(tuck|tucked|behind|background|sit back|subtle|out of the way)\b/.test(value)) return "background";
  if (/\b(primary|foundation|front and center)\b/.test(value)) return "primary";
  if (/\b(supporting|support|accompaniment)\b/.test(value)) return "supporting";
  return null;
}

function reasonLines(
  track: Track,
  read: ScopeRead,
  referenceName: string,
  gapDb: number,
  delta: number,
  overCap: boolean,
  overlapNote: string | null,
  defaultTier: Tier,
): string[] {
  if (delta === 0) return [];
  const where = read.section ? ` in ${read.section.name}` : "";
  const amount = formatSignedDb(Math.abs(delta)).replace("+", "");
  const direction = delta > 0 ? "Raised" : "Reduced";
  const tierName = tierLabel(read.tier, read.explicit, defaultTier);
  const lines: string[] = [];
  if (read.tier === "supporting" || read.tier === "background") {
    lines.push(
      `${direction} ${track.name} by ${amount} dB${where} because it is ${tierName} but its active level is louder than ${referenceName}.`,
    );
  } else if (read.tier === "focal") {
    lines.push(
      `${direction} ${track.name} by ${amount} dB${where} because it is marked Focal there and its active level sits ${Math.abs(gapDb).toFixed(1)} dB ${gapDb >= 0 ? "below" : "above"} ${referenceName}.`,
    );
  } else {
    lines.push(
      `${direction} ${track.name} by ${amount} dB${where} because it is ${tierName} and its active level sits ${Math.abs(gapDb).toFixed(1)} dB ${gapDb >= 0 ? "below" : "above"} ${referenceName}.`,
    );
  }
  if (overlapNote && delta < 0) lines.push(overlapNote);
  if (overCap) lines.push("The uncapped correction was larger than 6 dB, so this recommendation needs review before it is applied.");
  if ((read.metrics?.activePercent ?? 100) < 20) {
    lines.push("Only the active part of this stem was compared. A short or sparse stem was not turned up to match a full-song loudness number.");
  }
  return lines.slice(0, 6);
}

function tierLabel(tier: Tier, explicit: boolean, defaultTier: Tier): string {
  if (tier === "focal") return "Focal";
  if (tier === "primary") return explicit ? "Primary" : "a primary role";
  if (tier === "background") return explicit && defaultTier !== "background" ? "meant to sit back" : "Background";
  if (tier === "supporting") return explicit ? "Supporting" : "a supporting role";
  return "unlabeled";
}

function confidenceFor(track: Track, read: ScopeRead, overCap: boolean): number {
  let confidence = 0.58;
  if (track.role !== "other") confidence += 0.14;
  if (read.explicit) confidence += 0.08;
  if ((read.metrics?.activeSeconds ?? 0) >= 2) confidence += 0.1;
  else confidence -= 0.12;
  if (read.metrics?.metricsAgree) confidence += 0.08;
  if (read.tier === "unknown") confidence -= 0.3;
  if (overCap) confidence -= 0.1;
  if (read.section) confidence += 0.02;
  return clamp(Math.round(confidence * 100) / 100, 0.2, 0.95);
}

function overallConfidence(changes: GainRecommendation[], anchor: AnchorChoice, unknownRoles: number, unmeasured: number): number {
  if (anchor.level === null) return 0.32;
  const penalty = Math.min(0.28, unknownRoles * 0.06 + unmeasured * 0.05);
  if (changes.length === 0) return clamp(0.84 - penalty, 0.4, 0.9);
  const mean = changes.reduce((sum, change) => sum + change.confidence, 0) / changes.length;
  return clamp(Math.round((mean - penalty) * 100) / 100, 0.2, 0.95);
}

function summarize(
  changes: GainRecommendation[],
  anchor: AnchorChoice,
  unknownRoles: number,
  unmeasured: number,
  confidence: number,
): MixPlan["summary"] {
  const reviewCount = changes.filter((change) => change.status === "needs-review").length;
  const supporting = changes.filter((change) => change.deltaDb < 0 && /supporting|sit back|background/i.test(change.reasons[0] ?? "")).length;
  const focal = changes.filter((change) => change.scope.type === "section" && /focal/i.test(change.reasons[0] ?? "")).length;
  const primaryMoves = changes.filter((change) => change.scope.type === "global" && /primary/i.test(change.reasons[0] ?? "")).length;
  const notes: string[] = [];
  if (unknownRoles > 0) notes.push(`Confidence reduced because ${unknownRoles} ${unknownRoles === 1 ? "stem has" : "stems have"} no confirmed role.`);
  if (unmeasured > 0) notes.push(`${unmeasured} ${unmeasured === 1 ? "stem was" : "stems were"} not measured and left unchanged.`);
  if (anchor.level === null) notes.push(anchor.reason);
  let headline: string;
  if (anchor.level === null) {
    headline = "AutoBalance does not have enough evidence to change this mix.";
  } else if (changes.length === 0) {
    headline = "AutoBalance did not find a level change worth making.";
  } else {
    const bits = [`AutoBalance found ${changes.length} recommended ${changes.length === 1 ? "change" : "changes"}.`];
    if (primaryMoves > 0) bits.push(`${primaryMoves} ${primaryMoves === 1 ? "primary element moves" : "primary elements move"} toward ${anchor.label}.`);
    if (supporting > 0) bits.push(`${supporting} ${supporting === 1 ? "supporting track is" : "supporting tracks are"} reduced.`);
    if (focal > 0) bits.push(`${focal} focal section ${focal === 1 ? "adjustment was" : "adjustments were"} added.`);
    if (reviewCount > 0) bits.push(`${reviewCount} low-confidence ${reviewCount === 1 ? "recommendation needs" : "recommendations need"} review.`);
    headline = bits.join(" ");
  }
  return {
    goal: "balanced",
    confidence,
    headline,
    notes,
    changeCount: changes.length,
    reviewCount,
  };
}

function orderChanges(document: ProjectDocument, changes: GainRecommendation[]): GainRecommendation[] {
  const trackIndex = new Map(document.tracks.map((track, index) => [track.id, index]));
  const sectionIndex = new Map(document.sections.map((section, index) => [section.id, index]));
  return [...changes].sort((left, right) => {
    const tracks = (trackIndex.get(left.trackId) ?? 0) - (trackIndex.get(right.trackId) ?? 0);
    if (tracks !== 0) return tracks;
    if (left.scope.type !== right.scope.type) return left.scope.type === "global" ? -1 : 1;
    const leftSection = left.scope.type === "section" ? (sectionIndex.get(left.scope.sectionId) ?? 0) : -1;
    const rightSection = right.scope.type === "section" ? (sectionIndex.get(right.scope.sectionId) ?? 0) : -1;
    return leftSection - rightSection;
  });
}

function weightedMedian(items: Array<{ value: number; weight: number }>): number {
  const sorted = [...items].sort((left, right) => left.value - right.value || left.weight - right.weight);
  const total = sorted.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (sorted.length === 0) return 0;
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)]?.value ?? 0;
  let covered = 0;
  for (const item of sorted) {
    covered += Math.max(0, item.weight);
    if (covered >= total / 2) return item.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

function closest(wishes: ScopeWish[], target: number): ScopeWish {
  return [...wishes].sort((left, right) => Math.abs(left.delta - target) - Math.abs(right.delta - target))[0] ?? wishes[0]!;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
