import { STEREO_BANDS } from "@audiosous/analysis-contract";
import { TIER_RANK, type Tier } from "@audiosous/balance-planner";
import { activityFactor, saturate, type AnalysisScope, type InteractionAnalysis, type PairAnalysis } from "@audiosous/eq-planner";
import type { Track, TrackRole } from "@audiosous/project-model";
import { normalizeWeights, readConflict, type ConflictReading } from "./conflict";
import { BAND_GROUP, meanStats, type StereoModel } from "./model";
import { LEVEL_PROBLEM_DB, PEER_LEVEL_DB } from "./settings";
import { stereoPower, type Lrc } from "./stereo";

/**
 * Spatial interaction between two stems in one scope. It starts from Milestone 4's pair, which already
 * knows when the two play together, how much one competes for the other's frequencies (with faders,
 * section gain, and saved EQ heard), and which one matters more. This adds where each sits in the
 * stereo field in the bands where they compete.
 */

/** Usually kept in the middle. Never moved automatically; an explicit note can still move them. */
export const CENTER_ANCHORS: ReadonlySet<TrackRole> = new Set<TrackRole>(["kick", "bass", "snare-clap", "vocal", "lead", "drums"]);

export type PairOutcome = "mover" | "anchors" | "no-priority" | "level";

export interface SpatialPair {
  id: string;
  scope: AnalysisScope;
  eq: PairAnalysis;
  a: string;
  b: string;
  tierA: Tier;
  tierB: Tier;
  coSteps: number[];
  activity: number;
  /** Frequency competition for the stem that matters more (or the larger of the two directions), 0…1. */
  frequency: number;
  /** Share of that competition per stereo band. */
  weights: number[];
  priority: number;
  protectedId: string | null;
  moverId: string | null;
  outcome: PairOutcome;
  /** Mover minus protected level in the competing bands, dB. */
  levelGapDb: number;
  confidence: number;
  /** Mean statistics over the co-active steps: source (before width and pan) and heard, for each stem. */
  sourceA: Lrc[];
  sourceB: Lrc[];
  heardA: Lrc[];
  heardB: Lrc[];
}

export function buildSpatialPairs(analysis: InteractionAnalysis, model: StereoModel): SpatialPair[] {
  const out: SpatialPair[] = [];
  for (const eq of analysis.pairs) {
    const a = model.tracks.get(eq.a.track.id);
    const b = model.tracks.get(eq.b.track.id);
    if (!a || !b) continue;
    const sourceA = meanStats(a.source, eq.coSteps);
    const sourceB = meanStats(b.source, eq.coSteps);
    const heardA = meanStats(a.heard, eq.coSteps);
    const heardB = meanStats(b.heard, eq.coSteps);
    const decision = decide(eq, a.track, b.track, heardA, heardB);
    const victim = decision.protectedId === eq.b.track.id ? eq.aOnB : decision.protectedId === eq.a.track.id ? eq.bOnA : eq.bOnA.maskedFraction >= eq.aOnB.maskedFraction ? eq.bOnA : eq.aOnB;
    const grouped = Array.from({ length: STEREO_BANDS }, (_, band) => {
      let total = 0;
      for (let grid = band * BAND_GROUP; grid < (band + 1) * BAND_GROUP; grid += 1) total += victim.density[grid] ?? 0;
      return total;
    });
    const weights = normalizeWeights(grouped, victim.victimId === eq.a.track.id ? heardA : heardB);
    const frequency = saturate(victim.maskedFraction);
    const levelGapDb = decision.moverId ? levelGap(decision.moverId === eq.a.track.id ? heardA : heardB, decision.moverId === eq.a.track.id ? heardB : heardA, weights) : 0;
    const level = decision.moverId !== null && levelGapDb > LEVEL_PROBLEM_DB;
    out.push({
      id: eq.id,
      scope: eq.scope,
      eq,
      a: eq.a.track.id,
      b: eq.b.track.id,
      tierA: eq.tierA,
      tierB: eq.tierB,
      coSteps: eq.coSteps,
      activity: activityFactor(eq.simultaneity, eq.coverage),
      frequency,
      weights,
      priority: spatialPriority(
        decision.protectedId === eq.a.track.id ? eq.tierA : decision.protectedId === eq.b.track.id ? eq.tierB : maxTier(eq.tierA, eq.tierB),
        decision.protectedId === eq.a.track.id ? eq.tierB : decision.protectedId === eq.b.track.id ? eq.tierA : minTier(eq.tierA, eq.tierB),
        decision.equal,
      ),
      protectedId: decision.protectedId,
      moverId: level ? null : decision.moverId,
      outcome: level ? "level" : decision.outcome,
      levelGapDb,
      confidence: Math.max(0.2, Math.min(0.95, eq.confidence + (decision.equal ? -0.08 : 0))),
      sourceA,
      sourceB,
      heardA,
      heardB,
    });
  }
  return out;
}

/**
 * The pair's conflict as heard now. Read from the heard statistics with a neutral setting, which only
 * scales both channels equally, so it holds for the whole-song scope where settings change between sections.
 */
export function currentConflict(pair: SpatialPair): ConflictReading {
  return readConflict({ target: pair.heardA, other: pair.heardB, weights: pair.weights, frequency: pair.frequency, activity: pair.activity, mono: false }, { pan: 0, width: 1 });
}

interface Decision {
  protectedId: string | null;
  moverId: string | null;
  outcome: PairOutcome;
  equal: boolean;
}

/**
 * Who should move. The lower tier moves. A stem whose role is usually centered (kick, bass, snare, lead,
 * vocal, drum bus) is never the one moved automatically, and neither is a Primary or Focal stem.
 * Two Supporting or Background stems of equal tier: the quieter one in this scope moves.
 * Two Primary or Focal stems: no automatic mover.
 */
function decide(eq: PairAnalysis, a: Track, b: Track, heardA: Lrc[], heardB: Lrc[]): Decision {
  const rankA = TIER_RANK[eq.tierA];
  const rankB = TIER_RANK[eq.tierB];
  const movable = (track: Track, tier: Tier) => !CENTER_ANCHORS.has(track.role) && tier !== "primary" && tier !== "focal";
  if (rankA !== rankB) {
    const upper = rankA > rankB ? a : b;
    const lower = rankA > rankB ? b : a;
    const lowerTier = rankA > rankB ? eq.tierB : eq.tierA;
    if (!movable(lower, lowerTier)) return { protectedId: upper.id, moverId: null, outcome: "anchors", equal: false };
    return { protectedId: upper.id, moverId: lower.id, outcome: "mover", equal: false };
  }
  if (!movable(a, eq.tierA) || !movable(b, eq.tierB)) {
    const anchors = CENTER_ANCHORS.has(a.role) && CENTER_ANCHORS.has(b.role);
    return { protectedId: null, moverId: null, outcome: anchors ? "anchors" : "no-priority", equal: true };
  }
  const levelA = sumPower(heardA);
  const levelB = sumPower(heardB);
  // Peers only compete for space when they are similar in level; a part far under another is not in its way.
  if (levelA <= 0 || levelB <= 0 || Math.abs(10 * Math.log10(levelA / levelB)) > PEER_LEVEL_DB) {
    return { protectedId: null, moverId: null, outcome: "no-priority", equal: true };
  }
  // The quieter one gives way; on a tie the later stem in the track list does.
  const mover = levelA < levelB * 0.97 ? a : levelB < levelA * 0.97 ? b : b;
  return { protectedId: mover.id === a.id ? b.id : a.id, moverId: mover.id, outcome: "mover", equal: true };
}

/**
 * How much separating a pair is worth, from the tier of the stem that stays. Unlike EQ, layered parts of the
 * same role are not halved: two stacked synths sharing one space is exactly what spatial moves are for.
 */
function spatialPriority(upper: Tier, lower: Tier, equal: boolean): number {
  // As in EQ: a Background bed under a Primary or Focal part rarely hides it; Background parts are widened, not chased.
  if (upper === "focal" || upper === "primary") return lower === "background" ? 0.6 : 1;
  // Two Supporting peers of similar level fighting for one space matter more than a Supporting part over a quiet Background one.
  if (upper === "supporting") return equal ? 0.8 : 0.7;
  return upper === "background" ? 0.5 : 0.4;
}

function maxTier(left: Tier, right: Tier): Tier {
  return TIER_RANK[left] >= TIER_RANK[right] ? left : right;
}

function minTier(left: Tier, right: Tier): Tier {
  return TIER_RANK[left] <= TIER_RANK[right] ? left : right;
}

function sumPower(stats: Lrc[]): number {
  return stats.reduce((total, value) => total + stereoPower(value), 0);
}

/** How much louder the mover is, in the competing bands or overall while both play, whichever is larger. */
function levelGap(mover: Lrc[], protectedStats: Lrc[], weights: number[]): number {
  let m = 0;
  let p = 0;
  let mAll = 0;
  let pAll = 0;
  weights.forEach((weight, band) => {
    m += weight * stereoPower(mover[band]!);
    p += weight * stereoPower(protectedStats[band]!);
    mAll += stereoPower(mover[band]!);
    pAll += stereoPower(protectedStats[band]!);
  });
  if (m <= 0 || p <= 0 || mAll <= 0 || pAll <= 0) return 0;
  return Math.max(10 * Math.log10(m / p), 10 * Math.log10(mAll / pAll));
}

/** The contiguous bands that carry most of the competition, as a frequency range. */
export function conflictRange(weights: number[], edges: number[]): { lowHz: number; highHz: number } {
  let peak = 0;
  weights.forEach((value, band) => {
    if (value > weights[peak]!) peak = band;
  });
  let low = peak;
  let high = peak;
  let mass = weights[peak] ?? 0;
  while (mass < 0.6 && (low > 0 || high < weights.length - 1)) {
    const left = low > 0 ? weights[low - 1]! : -1;
    const right = high < weights.length - 1 ? weights[high + 1]! : -1;
    if (Math.max(left, right) < 0.08) break;
    if (left >= right) {
      low -= 1;
      mass += left;
    } else {
      high += 1;
      mass += right;
    }
  }
  return { lowHz: edges[low]!, highHz: edges[high + 1]! };
}
