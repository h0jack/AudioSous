import { TIER_RANK, indexSectionIntent, readTier, type SectionIntentIndex, type Tier } from "@audiosous/balance-planner";
import { TRACK_ROLE_LABELS, type ProjectDocument, type SongSection, type Track, type TrackRole } from "@audiosous/project-model";
import { GRID_BANDS, stepsIn, toDb, type BandGrid, type SpectralModel, type TrackSpectra } from "./spectra";

/**
 * Frequency interaction between two tracks while both are playing.
 *
 * Overlap is not masking. Two tracks can share a band and be fine when the important one is clearly
 * louder there. The score here asks a narrower question: of the energy that defines the more important
 * track (weighted by what matters for its role), how much sits in bands where the other track is at a
 * comparable or louder level, during the time both are active? That fraction, the share of time they
 * overlap, and how far apart they sit in the stereo field make the severity.
 *
 * It is an Audiosous decision heuristic on 24 log bands. It is not a psychoacoustic masking model.
 */

export type InteractionKind = "kick-bass" | "lead-support" | "hierarchy" | "equal" | "layered";

export interface AnalysisScope {
  key: string;
  sectionId: string | null;
  section: SongSection | null;
  name: string;
  start: number;
  end: number;
  /** A real section. Unmarked gaps and the whole song are evidence for track-wide moves only. */
  marked: boolean;
}

export interface ConflictRegion {
  centerHz: number;
  lowHz: number;
  highHz: number;
  /** First and last grid band, inclusive. */
  lowBand: number;
  highBand: number;
  /** Plain overlap inside the region: sum of the smaller band share. */
  sharedEnergy: number;
  /** Share of the protected track's weighted energy that is competed for inside this region. */
  maskedShare: number;
  /** Competitor minus protected level inside the region, dB, while both play. */
  levelDifferenceDb: number;
  severity: number;
  /** Share of the co-active time the competitor is within 6 dB of the protected track here. */
  persistence: number;
}

export interface DirectionResult {
  victimId: string;
  maskerId: string;
  maskedFraction: number;
  severity: number;
  regions: ConflictRegion[];
  /** Per band: the victim's weighted share that is competed for. */
  density: number[];
  weights: number[];
}

export interface PairAnalysis {
  id: string;
  scope: AnalysisScope;
  a: TrackSpectra;
  b: TrackSpectra;
  tierA: Tier;
  tierB: Tier;
  explicitA: boolean;
  explicitB: boolean;
  kind: InteractionKind;
  coSteps: number[];
  coSeconds: number;
  simultaneity: number;
  coverage: number;
  stereoSeparation: number;
  overlap: number;
  meanA: Float64Array;
  meanB: Float64Array;
  /** B competing for A's space, and A competing for B's. */
  bOnA: DirectionResult;
  aOnB: DirectionResult;
  priority: number;
  severity: number;
  confidence: number;
  protectedId: string | null;
  yieldingId: string | null;
}

export interface InteractionAnalysis {
  scopes: AnalysisScope[];
  pairs: PairAnalysis[];
  intents: SectionIntentIndex;
  tiers: Map<string, Map<string, { tier: Tier; explicit: boolean; intentText: string | null }>>;
  /** Pairs skipped before analysis, for the bounded-work note. */
  skippedPairs: number;
}

const MIN_CO_STEPS = 2;
const STEREO_RELIEF = 0.35;

export function analysisScopes(document: ProjectDocument): AnalysisScope[] {
  const song: AnalysisScope = {
    key: "song",
    sectionId: null,
    section: null,
    name: "Whole song",
    start: 0,
    end: document.project.durationSeconds,
    marked: false,
  };
  const ordered = [...document.sections].sort((left, right) => left.startTime - right.startTime);
  const scopes: AnalysisScope[] = [song];
  let cursor = 0;
  for (const section of [...ordered, null]) {
    const end = section ? section.startTime : document.project.durationSeconds;
    if (ordered.length > 0 && end - cursor >= 1) {
      scopes.push({ key: `__unmarked:${cursor}`, sectionId: null, section: null, name: "unmarked time", start: cursor, end, marked: false });
    }
    if (!section) break;
    scopes.push({ key: section.id, sectionId: section.id, section, name: section.name, start: section.startTime, end: section.endTime, marked: true });
    cursor = Math.max(cursor, section.endTime);
  }
  return scopes;
}

export function analyzeInteractions(document: ProjectDocument, model: SpectralModel): InteractionAnalysis {
  const intents = indexSectionIntent(document);
  const scopes = analysisScopes(document);
  const tiers = scopeTiers(document, model, scopes, intents);
  const list = [...model.tracks.values()];
  const loudest = Math.max(-200, ...list.map((item) => activeLevelDb(item, model)));
  const pairs: PairAnalysis[] = [];
  let skippedPairs = 0;
  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      const a = list[left]!;
      const b = list[right]!;
      // Very quiet elements are not worth an EQ move on either side.
      if (activeLevelDb(a, model) < loudest - 36 || activeLevelDb(b, model) < loudest - 36) {
        skippedPairs += 1;
        continue;
      }
      for (const scope of scopes) {
        const tierA = tiers.get(a.track.id)?.get(scope.key);
        const tierB = tiers.get(b.track.id)?.get(scope.key);
        if (!tierA || !tierB) continue;
        if (tierA.tier === "background" && tierB.tier === "background") continue;
        const pair = analyzePair(model, scope, a, b, tierA, tierB);
        if (pair) pairs.push(pair);
      }
    }
  }
  return { scopes, pairs, intents, tiers, skippedPairs };
}

function analyzePair(
  model: SpectralModel,
  scope: AnalysisScope,
  a: TrackSpectra,
  b: TrackSpectra,
  tierA: { tier: Tier; explicit: boolean },
  tierB: { tier: Tier; explicit: boolean },
): PairAnalysis | null {
  const steps = stepsIn(model, scope.start, scope.end);
  if (steps.length === 0) return null;
  let countA = 0;
  let countB = 0;
  const coSteps: number[] = [];
  for (const step of steps) {
    const onA = a.active[step] === 1;
    const onB = b.active[step] === 1;
    if (onA) countA += 1;
    if (onB) countB += 1;
    if (onA && onB) coSteps.push(step);
  }
  const sparser = Math.min(countA, countB);
  // Tracks that never or barely play together do not interact, whatever their spectra look like.
  if (coSteps.length < MIN_CO_STEPS || coSteps.length < sparser * 0.1) return null;
  const meanA = meanBands(a, coSteps);
  const meanB = meanBands(b, coSteps);
  const simultaneity = coSteps.length / Math.max(1, sparser);
  const coverage = coSteps.length / steps.length;
  const stereoSeparation = separation(a, b);
  const activity = activityFactor(simultaneity, coverage);
  const stereo = stereoFactor(stereoSeparation);
  const bOnA = assessDirection(model.grid, a, b, meanA, meanB, tierA.tier, coSteps, activity * stereo);
  const aOnB = assessDirection(model.grid, b, a, meanB, meanA, tierB.tier, coSteps, activity * stereo);
  const kind = kindOf(a.track, b.track, tierA.tier, tierB.tier, tierA.explicit || tierB.explicit);
  const rankA = TIER_RANK[tierA.tier];
  const rankB = TIER_RANK[tierB.tier];
  let protectedId: string | null = null;
  let yieldingId: string | null = null;
  if (kind !== "layered" && rankA !== rankB) {
    protectedId = rankA > rankB ? a.track.id : b.track.id;
    yieldingId = rankA > rankB ? b.track.id : a.track.id;
  }
  const relevant = protectedId === a.track.id ? bOnA : protectedId === b.track.id ? aOnB : bOnA.severity >= aOnB.severity ? bOnA : aOnB;
  const priority = pairPriority(kind, protectedId ? (protectedId === a.track.id ? tierA.tier : tierB.tier) : maxTier(tierA.tier, tierB.tier), protectedId ? (yieldingId === a.track.id ? tierA.tier : tierB.tier) : minTier(tierA.tier, tierB.tier));
  const overlap = sharedEnergy(meanA, meanB, 0, GRID_BANDS - 1);
  const persistence = relevant.regions[0]?.persistence ?? 0;
  let confidence = 0.5;
  if (simultaneity >= 0.6) confidence += 0.12;
  if (coSteps.length * model.stepSeconds >= 4) confidence += 0.08;
  confidence += 0.15 * persistence;
  if (a.track.role === "other" || b.track.role === "other") confidence -= 0.1;
  if (kind === "equal" || kind === "layered") confidence -= 0.15;
  return {
    id: `${scope.key}::${a.track.id}::${b.track.id}`,
    scope,
    a,
    b,
    tierA: tierA.tier,
    tierB: tierB.tier,
    explicitA: tierA.explicit,
    explicitB: tierB.explicit,
    kind,
    coSteps,
    coSeconds: coSteps.length * model.stepSeconds,
    simultaneity,
    coverage,
    stereoSeparation,
    overlap,
    meanA,
    meanB,
    bOnA,
    aOnB,
    priority,
    severity: relevant.severity,
    confidence: clamp(round2(confidence), 0.2, 0.95),
    protectedId,
    yieldingId,
  };
}

/** How much `masker` competes for `victim`'s space. */
export function assessDirection(
  grid: BandGrid,
  victim: TrackSpectra,
  masker: TrackSpectra,
  meanVictim: Float64Array,
  meanMasker: Float64Array,
  victimTier: Tier,
  coSteps: number[],
  scale: number,
): DirectionResult {
  const totalVictim = sum(meanVictim);
  const weights = grid.centers.map((hz) => regionWeight(victim.track.role, victimTier, hz));
  const density: number[] = [];
  let identity = 0;
  for (let band = 0; band < GRID_BANDS; band += 1) {
    const share = totalVictim > 0 ? meanVictim[band]! / totalVictim : 0;
    identity += share * weights[band]!;
    const gap = toDb(meanMasker[band]!) - toDb(meanVictim[band]!);
    density.push(share * weights[band]! * maskCurve(gap));
  }
  const maskedFraction = identity > 0 ? sum(density) / identity : 0;
  const severity = saturate(maskedFraction) * scale;
  const regions = findRegions(density, identity).map((span) => {
    const masked = identity > 0 ? sumRange(density, span.low, span.high) / identity : 0;
    const victimPower = sumRange(meanVictim, span.low, span.high);
    const maskerPower = sumRange(meanMasker, span.low, span.high);
    return {
      centerHz: weightedCenter(grid, density, span.low, span.high),
      lowHz: grid.edges[span.low]!,
      highHz: grid.edges[span.high + 1]!,
      lowBand: span.low,
      highBand: span.high,
      sharedEnergy: sharedEnergy(meanVictim, meanMasker, span.low, span.high),
      maskedShare: masked,
      levelDifferenceDb: toDb(maskerPower) - toDb(victimPower),
      severity: saturate(masked) * scale,
      persistence: persistenceOf(victim, masker, coSteps, span.low, span.high),
    };
  });
  return { victimId: victim.track.id, maskerId: masker.track.id, maskedFraction, severity, regions, density, weights };
}

export function activityFactor(simultaneity: number, coverage: number): number {
  return Math.sqrt(Math.min(1, simultaneity)) * (0.6 + 0.4 * Math.min(1, coverage / 0.5));
}

export function stereoFactor(separationAmount: number): number {
  return 1 - STEREO_RELIEF * separationAmount;
}

/** 0.5 when the competitor is 4 dB under, about 0.83 at equal level, near 0 at 12 dB under. */
export function maskCurve(competitorMinusVictimDb: number): number {
  return 1 / (1 + Math.exp(-(competitorMinusVictimDb + 4) / 2.5));
}

/** Half the weighted energy competed for reads as 0.63; a quarter as 0.39. Keeps dense mixes rankable. */
export function saturate(fraction: number): number {
  return 1 - Math.exp(-Math.max(0, fraction) / 0.5);
}

/** Up to two broad regions, each no wider than seven bands (about three octaves). */
function findRegions(density: number[], identity: number): Array<{ low: number; high: number }> {
  const taken = new Array<boolean>(GRID_BANDS).fill(false);
  const regions: Array<{ low: number; high: number; mass: number }> = [];
  for (let round = 0; round < 2; round += 1) {
    let peak = -1;
    for (let band = 0; band < GRID_BANDS; band += 1) {
      if (taken[band]) continue;
      if (peak < 0 || density[band]! > density[peak]!) peak = band;
    }
    if (peak < 0 || identity <= 0 || density[peak]! / identity < 0.02) break;
    let low = peak;
    let high = peak;
    const floor = density[peak]! * 0.4;
    while (high - low < 6) {
      const left = low > 0 && !taken[low - 1] ? density[low - 1]! : -1;
      const right = high < GRID_BANDS - 1 && !taken[high + 1] ? density[high + 1]! : -1;
      if (left < floor && right < floor) break;
      if (left >= right) low -= 1;
      else high += 1;
    }
    const mass = sumRange(density, low, high);
    if (regions.length > 0 && mass < regions[0]!.mass * 0.5) break;
    for (let band = low; band <= high; band += 1) taken[band] = true;
    regions.push({ low, high, mass });
  }
  return regions.map(({ low, high }) => ({ low, high }));
}

function persistenceOf(victim: TrackSpectra, masker: TrackSpectra, coSteps: number[], low: number, high: number): number {
  if (coSteps.length === 0) return 0;
  let hits = 0;
  for (const step of coSteps) {
    let v = 0;
    let m = 0;
    for (let band = low; band <= high; band += 1) {
      v += victim.power[step * GRID_BANDS + band]!;
      m += masker.power[step * GRID_BANDS + band]!;
    }
    if (toDb(m) >= toDb(v) - 6) hits += 1;
  }
  return hits / coSteps.length;
}

/** What matters for a role, by frequency. A heuristic per role family, not one curve for every pair. */
export function regionWeight(role: TrackRole, tier: Tier, hz: number): number {
  const inRange = (low: number, high: number) => hz >= low && hz < high;
  let weight: number;
  switch (role) {
    case "kick":
      weight = inRange(40, 120) ? 1 : inRange(120, 250) ? 0.5 : inRange(2_000, 6_000) ? 0.6 : 0.2;
      break;
    case "bass":
      weight = inRange(35, 250) ? 1 : inRange(250, 800) ? 0.6 : inRange(800, 3_000) ? 0.45 : 0.15;
      break;
    case "snare-clap":
      weight = inRange(150, 300) || inRange(1_000, 6_000) ? 0.9 : inRange(300, 1_000) ? 0.5 : 0.2;
      break;
    case "hi-hat":
      weight = inRange(5_000, 14_000) ? 1 : inRange(2_000, 5_000) ? 0.6 : 0.15;
      break;
    case "percussion":
      weight = inRange(200, 8_000) ? 0.7 : 0.3;
      break;
    case "drums":
      weight = inRange(40, 120) ? 0.8 : 0.6;
      break;
    case "pad":
    case "atmosphere":
    case "backing-vocal":
      weight = inRange(150, 3_000) ? 0.6 : 0.3;
      break;
    case "fx":
    case "other":
      weight = 0.5;
      break;
    default:
      // Lead, vocal, and melodic parts: body, then intelligibility and presence.
      weight = inRange(1_000, 5_000) ? 1 : inRange(300, 1_000) ? 0.75 : inRange(5_000, 10_000) ? 0.6 : inRange(150, 300) ? 0.45 : 0.2;
  }
  // A track promoted to Focal in a section is listened to for its melody, wherever its role sits.
  if (tier === "focal" && weight < 0.75 && hz >= 300 && hz < 6_000) weight = 0.75;
  return weight;
}

function kindOf(a: Track, b: Track, tierA: Tier, tierB: Tier, explicit: boolean): InteractionKind {
  const roles = new Set([a.role, b.role]);
  if (roles.has("kick") && roles.has("bass")) return "kick-bass";
  if (!explicit && layered(a, b)) return "layered";
  const leadish = (track: Track, tier: Tier) => track.role === "lead" || track.role === "vocal" || tier === "focal";
  const support = (track: Track) => ["pad", "synth", "keys", "guitar", "strings", "brass", "backing-vocal", "atmosphere"].includes(track.role);
  if ((leadish(a, tierA) && support(b) && TIER_RANK[tierA] > TIER_RANK[tierB]) || (leadish(b, tierB) && support(a) && TIER_RANK[tierB] > TIER_RANK[tierA])) {
    return "lead-support";
  }
  return TIER_RANK[tierA] === TIER_RANK[tierB] ? "equal" : "hierarchy";
}

/** Same role, or names that differ only by a number or a side: stacked synths, doubled guitars, layered vocals. */
function layered(a: Track, b: Track): boolean {
  if (a.role === b.role && a.role !== "other" && a.role !== "kick" && a.role !== "bass") return true;
  const strip = (name: string) =>
    name
      .toLowerCase()
      .replace(/\b(l|r|left|right|dbl|double|layer|alt|copy|\d+)\b/g, " ")
      .replace(/[^a-z]+/g, " ")
      .trim();
  return strip(a.name) !== "" && strip(a.name) === strip(b.name);
}

function pairPriority(kind: InteractionKind, upper: Tier, lower: Tier): number {
  if (kind === "kick-bass" || kind === "lead-support") return 1;
  const base =
    upper === "focal" ? 1 : upper === "primary" ? (lower === "background" ? 0.6 : 0.85) : upper === "supporting" ? 0.45 : upper === "unknown" ? 0.35 : 0.15;
  return kind === "layered" ? base * 0.5 : base;
}

/**
 * Tier per track and scope. A section reads Track × Section prominence and notes the same way AutoBalance does.
 * The whole song takes the tier that holds for most of the track's active time.
 */
function scopeTiers(
  document: ProjectDocument,
  model: SpectralModel,
  scopes: AnalysisScope[],
  intents: SectionIntentIndex,
): InteractionAnalysis["tiers"] {
  const out: InteractionAnalysis["tiers"] = new Map();
  for (const spectra of model.tracks.values()) {
    const track = spectra.track;
    const perScope = new Map<string, { tier: Tier; explicit: boolean; intentText: string | null }>();
    const votes = new Map<Tier, number>();
    let explicitVotes = 0;
    let voted = 0;
    for (const scope of scopes) {
      if (scope.key === "song") continue;
      const read = readTier(document, track, scope.section, intents);
      perScope.set(scope.key, { tier: read.tier, explicit: read.explicit, intentText: read.intentText });
      const active = stepsIn(model, scope.start, scope.end).filter((step) => spectra.active[step] === 1).length;
      votes.set(read.tier, (votes.get(read.tier) ?? 0) + active);
      if (read.explicit) explicitVotes += active;
      voted += active;
    }
    const role = readTier(document, track, null, intents);
    let songTier: Tier = role.tier;
    let best = -1;
    for (const [tier, count] of votes) {
      if (count > best || (count === best && TIER_RANK[tier] > TIER_RANK[songTier])) {
        songTier = tier;
        best = count;
      }
    }
    if (voted === 0) songTier = role.tier;
    perScope.set("song", { tier: songTier, explicit: voted > 0 && explicitVotes / voted >= 0.5, intentText: null });
    out.set(track.id, perScope);
  }
  return out;
}

export function activeLevelDb(spectra: TrackSpectra, model: SpectralModel): number {
  let total = 0;
  let count = 0;
  for (let step = 0; step < model.steps; step += 1) {
    if (spectra.active[step] !== 1) continue;
    for (let band = 0; band < GRID_BANDS; band += 1) total += spectra.power[step * GRID_BANDS + band]!;
    count += 1;
  }
  return count === 0 ? -200 : toDb(total / count);
}

export function meanBands(spectra: TrackSpectra, steps: number[]): Float64Array {
  const out = new Float64Array(GRID_BANDS);
  if (steps.length === 0) return out;
  for (const step of steps) {
    for (let band = 0; band < GRID_BANDS; band += 1) out[band] += spectra.power[step * GRID_BANDS + band]!;
  }
  for (let band = 0; band < GRID_BANDS; band += 1) out[band] /= steps.length;
  return out;
}

export function separation(a: TrackSpectra, b: TrackSpectra): number {
  const distance = Math.abs(a.position - b.position) / 2;
  const width = (Math.min(1, a.width) + Math.min(1, b.width)) / 2;
  return clamp(distance * (1 - 0.5 * width), 0, 1);
}

export function sharedEnergy(left: Float64Array, right: Float64Array, low: number, high: number): number {
  const totalLeft = sum(left);
  const totalRight = sum(right);
  if (totalLeft <= 0 || totalRight <= 0) return 0;
  let shared = 0;
  for (let band = low; band <= high; band += 1) shared += Math.min(left[band]! / totalLeft, right[band]! / totalRight);
  return shared;
}

function weightedCenter(grid: BandGrid, density: number[], low: number, high: number): number {
  let weight = 0;
  let log = 0;
  for (let band = low; band <= high; band += 1) {
    weight += density[band]!;
    log += density[band]! * Math.log(grid.centers[band]!);
  }
  return weight > 0 ? Math.exp(log / weight) : Math.sqrt(grid.edges[low]! * grid.edges[high + 1]!);
}

export function roleLabel(track: Track): string {
  return track.role === "other" && track.customLabel ? track.customLabel : TRACK_ROLE_LABELS[track.role];
}

function maxTier(left: Tier, right: Tier): Tier {
  return TIER_RANK[left] >= TIER_RANK[right] ? left : right;
}

function minTier(left: Tier, right: Tier): Tier {
  return TIER_RANK[left] <= TIER_RANK[right] ? left : right;
}

function sum(values: ArrayLike<number>): number {
  let total = 0;
  for (let index = 0; index < values.length; index += 1) total += values[index]!;
  return total;
}

function sumRange(values: ArrayLike<number>, low: number, high: number): number {
  let total = 0;
  for (let index = low; index <= high; index += 1) total += values[index]!;
  return total;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
