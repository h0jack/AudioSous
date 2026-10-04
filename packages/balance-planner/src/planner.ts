import { ANALYSIS_ENGINE_VERSION, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import {
  TRACK_ROLE_LABELS,
  type ProjectDocument,
  type SongSection,
  type Track,
  type TrackRole,
} from "@audiosous/project-model";
import { indexSectionIntent, trackIntentTier, type SectionIntentIndex } from "./intent";
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

/**
 * Where a scope's tier came from, highest precedence first:
 * explicit Track × Section prominence, Track × Section note, section note naming the track, role.
 */
type TierSource = "prominence" | "track-intent" | "section-intent" | "role";

interface ScopeRead {
  section: SongSection | null;
  metrics: BalanceMetrics | null;
  tier: Tier;
  defaultTier: Tier;
  explicit: boolean;
  source: TierSource;
  /** The note clause that set the tier, when it came from text. */
  intentText: string | null;
  /** A section note had a level instruction that could mean this track or another one. */
  ambiguous: boolean;
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
  referenceLevel: number;
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
  const intents = indexSectionIntent(document);
  const unknownRoles = document.tracks.filter((track) => track.role === "other" && !track.customLabel).length;
  const unmeasured = document.tracks.filter((track) => !input.measurements[track.id]?.track).length;
  const changes: GainRecommendation[] = [];
  if (anchor.level !== null) {
    for (const track of document.tracks) {
      if (track.muted) continue;
      changes.push(...planTrack(document, track, input.measurements, anchor, limits, intents));
    }
  }
  const ordered = orderChanges(document, changes);
  const confidence = overallConfidence(ordered, anchor, unknownRoles, unmeasured);
  const summary = summarize(ordered, anchor, unknownRoles, unmeasured, confidence, ambiguityNotes(document, intents));
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
  intents: SectionIntentIndex,
): GainRecommendation[] {
  const bag = measurements[track.id];
  const defaultTier = defaultTierFor(track, document.tracks);
  const sections = document.sections;
  const reads = sections.length
    ? sections.map((section) => readScope(document, track, bag, section, defaultTier, intents))
    : [readScope(document, track, bag, null, defaultTier, intents)];
  const songLevel = balanceMetrics(bag?.track ?? null)?.activeLevelDb ?? null;
  const active = reads
    .filter((read) => read.audible !== null && (read.metrics?.activeSeconds ?? 0) >= 0.45 && (read.metrics?.activePercent ?? 0) >= 8)
    // A primary element playing well under its own song level (a fade-in, a quiet passage) is an arrangement choice, not a balance error.
    .filter((read) => read.explicit || read.tier !== "primary" || !read.section || songLevel === null || read.audible! >= songLevel + track.gainDb - 6);
  if (active.length === 0) return [];
  const wishes = active
    .map((read) => wishFor(document, track, read, measurements, anchor, limits, defaultTier, intents))
    .filter((wish): wish is ScopeWish => wish !== null);
  const corrected = correctOnce(track, wishes, limits);
  return regularize(document, track, corrected, limits);
}

function readScope(
  document: ProjectDocument,
  track: Track,
  bag: TrackMeasurements | undefined,
  section: SongSection | null,
  defaultTier: Tier,
  intents: SectionIntentIndex,
): ScopeRead {
  const setting = section
    ? document.sectionTrackSettings.find((item) => item.trackId === track.id && item.sectionId === section.id)
    : undefined;
  const metrics = section
    ? balanceMetrics(bag?.sections?.[section.id] ?? null) ?? balanceMetrics(bag?.track ?? null, { start: section.startTime, end: section.endTime })
    : balanceMetrics(bag?.track ?? null);
  const trackNote = section ? trackIntentTier(document, track, setting?.userIntent) : null;
  const sectionNote = section ? (intents.targets.get(section.id)?.get(track.id) ?? null) : null;
  const ambiguous = section ? intents.ambiguous.some((item) => item.sectionId === section.id && item.trackIds.includes(track.id)) : false;
  let tier: Tier = defaultTier;
  let source: TierSource = "role";
  let intentText: string | null = null;
  if (setting?.prominence) {
    tier = setting.prominence;
    source = "prominence";
  } else if (trackNote) {
    tier = trackNote.tier;
    source = "track-intent";
    intentText = trackNote.text;
  } else if (sectionNote) {
    tier = sectionNote.tier;
    source = "section-intent";
    intentText = sectionNote.text;
  }
  const explicit = source !== "role";
  const currentGainDb = section ? (setting?.overrides.gainDb ?? track.gainDb) : track.gainDb;
  const audible = metrics?.activeLevelDb === null || metrics?.activeLevelDb === undefined ? null : metrics.activeLevelDb + currentGainDb;
  return { section, metrics, tier, defaultTier, explicit, source, intentText, ambiguous: ambiguous && source === "role", audible, currentGainDb };
}

function wishFor(
  document: ProjectDocument,
  track: Track,
  read: ScopeRead,
  measurements: Record<string, TrackMeasurements | undefined>,
  anchor: AnchorChoice,
  limits: StrengthLimits,
  defaultTier: Tier,
  intents: SectionIntentIndex,
): ScopeWish | null {
  const audible = read.audible ?? 0;
  const reference = referenceLevel(document, track, read, measurements, anchor, intents);
  if (!reference) return null;
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
    const error = target - audible;
    raw = (error < 0 ? softWindow(error, limits.overKickToleranceDb) : error) * limits.primaryMix * 0.7;
  } else {
    const gap = reference.level - audible;
    const tolerance = reference.role === "kick" && gap < 0 ? limits.overKickToleranceDb : limits.primaryToleranceDb;
    raw = softWindow(gap, tolerance) * limits.primaryMix;
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
    referenceLevel: reference.level,
    gapDb,
  };
}

function correctOnce(track: Track, wishes: ScopeWish[], limits: StrengthLimits): ScopeWish[] {
  return wishes.map((wish) => {
    if (wish.read.tier !== "supporting" && wish.read.tier !== "background") return wish;
    if (wish.read.audible === null) return wish;
    const simulated = wish.read.audible + wish.delta;
    // Same reference the wish was planned against, so the check cannot disagree with the first pass.
    const limit = wish.referenceLevel - 0.8;
    if (simulated <= limit) return wish;
    const room = limits.maxDb - Math.abs(wish.delta);
    if (room < 0.4 || wish.delta > 0) return wish;
    const extra = Math.min(room, simulated - limit, 1);
    const delta = roundDb(wish.delta - extra);
    if (Math.abs(delta) < limits.deadbandDb) return wish;
    const overCap = wish.overCap || Math.abs(wish.raw) > REVIEW_GAIN_DB;
    const reasons = [
      ...reasonLines(track, wish.read, wish.referenceName, wish.gapDb, delta, overCap, null, wish.read.defaultTier),
      `A follow-up check still had ${track.name} above the primary level, so the reduction was deepened slightly.`,
    ];
    return { ...wish, delta, reasons: reasons.slice(0, 6), overCap };
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
      // Never let a section row push against its own intent: a "quieter" section is not held up against a track-wide cut.
      const reduces = wish.read.tier === "background" || wish.read.tier === "supporting";
      if ((reduces && offset > 0) || (wish.read.tier === "focal" && offset < 0)) continue;
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
  const globalMove = roundDb(recommended - offset - track.gainDb);
  if (scope.type === "section" && wish.read.section && Math.abs(globalMove) >= 0.05 && reasons.length > 0) {
    reasons = [
      ...reasons,
      `With the ${formatSignedDb(globalMove)} dB track-wide change, ${wish.read.section.name} sits ${formatSignedDb(offset)} dB relative to the rest of ${track.name}.`,
    ].slice(0, 6);
  }
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
    reasons: reasons.length > 0 ? reasons : [holdReason(track, wish, scope, recommendedGainDb - offset)],
  };
}

function holdReason(track: Track, wish: ScopeWish, scope: RecommendationScope, plannedGlobal: number): string {
  if (scope.type !== "section" || !wish.read.section) return `${track.name} stays at its current gain.`;
  const move = roundDb(plannedGlobal - track.gainDb);
  return `Holds ${track.name} at its current level in ${wish.read.section.name}, so the ${formatSignedDb(move)} dB track-wide change does not apply there. That section already sits where it should.`;
}

function referenceLevel(
  document: ProjectDocument,
  track: Track,
  read: ScopeRead,
  measurements: Record<string, TrackMeasurements | undefined>,
  anchor: AnchorChoice,
  intents: SectionIntentIndex,
): { level: number; name: string; role: TrackRole | null; trackId: string | null } | null {
  const anchorTrack = document.tracks.find((item) => item.id === anchor.trackIds[0]);
  // Primary elements are held to the anchor, not to each other. Two primaries chasing the louder one
  // would both move and swap places. Where the anchor is not playing there is no primary opinion.
  if (read.tier === "primary" && anchorTrack && anchorTrack.id !== track.id) {
    if (!read.section) return { level: anchor.level ?? read.audible ?? 0, name: anchorTrack.name, role: anchorTrack.role, trackId: anchorTrack.id };
    const anchorRead = readScope(document, anchorTrack, measurements[anchorTrack.id], read.section, defaultTierFor(anchorTrack, document.tracks), intents);
    if (anchorRead.audible === null || !established(anchorTrack, anchorRead, measurements)) return null;
    return { level: anchorRead.audible, name: anchorTrack.name, role: anchorTrack.role, trackId: anchorTrack.id };
  }
  const peers = document.tracks
    .filter((peer) => peer.id !== track.id && !peer.muted)
    .map((peer) => {
      const peerRead = readScope(document, peer, measurements[peer.id], read.section, defaultTierFor(peer, document.tracks), intents);
      return { peer, peerRead };
    })
    .filter((item) => item.peerRead.audible !== null && (item.peerRead.tier === "primary" || item.peerRead.tier === "focal"))
    .filter((item) => established(item.peer, item.peerRead, measurements));
  const loudest = peers.sort((left, right) => (right.peerRead.audible ?? -200) - (left.peerRead.audible ?? -200))[0];
  if (loudest?.peerRead.audible !== null && loudest?.peerRead.audible !== undefined) {
    return { level: loudest.peerRead.audible, name: loudest.peer.name, role: loudest.peer.role, trackId: loudest.peer.id };
  }
  const fallbackName = anchorTrack?.name ?? anchor.label;
  return {
    level: anchor.level ?? read.audible ?? 0,
    name: read.section ? `${fallbackName}'s level in the rest of the song` : fallbackName,
    role: anchorTrack?.role ?? null,
    trackId: anchorTrack?.id ?? null,
  };
}

/**
 * A peer only sets a section's reference when it is really playing there: active for a good share of the section
 * and not far under its own song level. A lead fading in under an intro pad is not the intro's reference.
 */
function established(peer: Track, read: ScopeRead, measurements: Record<string, TrackMeasurements | undefined>): boolean {
  if (!read.section || read.audible === null) return true;
  if (read.tier === "focal" && read.explicit) return true;
  const songLevel = balanceMetrics(measurements[peer.id]?.track ?? null)?.activeLevelDb;
  if (songLevel === null || songLevel === undefined) return true;
  const songAudible = songLevel + read.currentGainDb;
  return (read.metrics?.activePercent ?? 0) >= 35 && read.audible >= songAudible - 6;
}

function chooseAnchor(document: ProjectDocument, measurements: Record<string, TrackMeasurements | undefined>): AnchorChoice {
  const ranked = document.tracks
    .filter((track) => !track.muted)
    .map((track) => {
      const metrics = balanceMetrics(measurements[track.id]?.track ?? null);
      const tier = defaultTierFor(track, document.tracks);
      return { track, metrics, tier };
    })
    .filter((item) => item.tier === "primary" && item.metrics?.activeLevelDb !== null && (item.metrics?.activePercent ?? 0) >= 35);
  const preferred = ANCHOR_ORDER.map((role) => ranked.find((item) => item.track.role === role)).find((item) => item !== undefined);
  const chosen = preferred ?? ranked.sort((left, right) => (right.metrics?.activePercent ?? 0) - (left.metrics?.activePercent ?? 0))[0];
  if (!chosen || chosen.metrics?.activeLevelDb === null || chosen.metrics?.activeLevelDb === undefined) {
    return {
      trackIds: [],
      label: "None",
      reason: "No Primary element is active enough to anchor the balance. Levels were left unchanged.",
      level: null,
    };
  }
  const level = chosen.metrics.activeLevelDb + chosen.track.gainDb;
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
    const marked = read.source === "prominence" ? "it is marked Focal there" : "its note asks for it to be Focal there";
    lines.push(
      `${direction} ${track.name} by ${amount} dB${where} because ${marked} and its active level sits ${Math.abs(gapDb).toFixed(1)} dB ${gapDb >= 0 ? "below" : "above"} ${referenceName}.`,
    );
  } else {
    lines.push(
      `${direction} ${track.name} by ${amount} dB${where} because it is ${tierName} and its active level sits ${Math.abs(gapDb).toFixed(1)} dB ${gapDb >= 0 ? "below" : "above"} ${referenceName}.`,
    );
  }
  if (read.intentText && read.section) {
    const note = read.source === "section-intent" ? `the ${read.section.name} section note` : `the ${track.name} note for ${read.section.name}`;
    lines.push(`Level intent read from ${note}: "${quoteIntent(read.intentText)}".`);
  }
  if (read.ambiguous) lines.push("A section note gave a level instruction that could mean this track or another one, so it was not applied here.");
  if (overlapNote && delta < 0) lines.push(overlapNote);
  if (overCap) lines.push("The uncapped correction was larger than 6 dB, so this recommendation needs review before it is applied.");
  if ((read.metrics?.activePercent ?? 100) < 20) {
    lines.push("Only the active part of this stem was compared. A short or sparse stem was not turned up to match a full-song loudness number.");
  }
  return lines.slice(0, 6);
}

function quoteIntent(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
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
  // Structured settings are more certain than a phrase match; a phrase match on a section note is the weakest.
  if (read.source === "prominence") confidence += 0.08;
  else if (read.source === "track-intent") confidence += 0.06;
  else if (read.source === "section-intent") confidence += 0.04;
  if (read.ambiguous) confidence -= 0.08;
  if ((read.metrics?.activeSeconds ?? 0) >= 2) confidence += 0.1;
  else confidence -= 0.12;
  if (read.metrics?.metricsAgree) confidence += 0.08;
  if (read.tier === "unknown") confidence -= 0.3;
  if (overCap) confidence -= 0.1;
  if (read.section) confidence += 0.02;
  // A phrase match never reads as certain as a structured setting.
  const ceiling = read.source === "section-intent" ? 0.85 : read.source === "track-intent" ? 0.9 : 0.95;
  return clamp(Math.round(confidence * 100) / 100, 0.2, ceiling);
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
  intentNotes: string[],
): MixPlan["summary"] {
  const reviewCount = changes.filter((change) => change.status === "needs-review").length;
  const supporting = changes.filter((change) => change.deltaDb < 0 && /supporting|sit back|background/i.test(change.reasons[0] ?? "")).length;
  const focal = changes.filter((change) => change.scope.type === "section" && /focal/i.test(change.reasons[0] ?? "")).length;
  const primaryMoves = changes.filter((change) => change.scope.type === "global" && /primary/i.test(change.reasons[0] ?? "")).length;
  const notes: string[] = [];
  if (unknownRoles > 0) notes.push(`Confidence reduced because ${unknownRoles} ${unknownRoles === 1 ? "stem has" : "stems have"} no confirmed role.`);
  if (unmeasured > 0) notes.push(`${unmeasured} ${unmeasured === 1 ? "stem was" : "stems were"} not measured and left unchanged.`);
  if (anchor.level === null) notes.push(anchor.reason);
  notes.push(...intentNotes.slice(0, Math.max(0, 6 - notes.length)));
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

function ambiguityNotes(document: ProjectDocument, intents: SectionIntentIndex): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const item of intents.ambiguous) {
    const key = `${item.sectionId}:${item.word}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const section = document.sections.find((entry) => entry.id === item.sectionId);
    const names = item.trackIds.map((id) => document.tracks.find((track) => track.id === id)?.name ?? id);
    notes.push(
      `The ${section?.name ?? "section"} note "${quoteIntent(item.text)}" could mean ${names.join(" or ")}, so it was not applied. Name the stem or set its prominence in that section.`,
    );
  }
  return notes;
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

/** Zero inside the tolerance, full value at twice the tolerance, linear between. */
function softWindow(value: number, tolerance: number): number {
  const size = Math.abs(value);
  if (tolerance <= 0 || size >= tolerance * 2) return value;
  if (size <= tolerance) return 0;
  return value * ((size - tolerance) / tolerance);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
