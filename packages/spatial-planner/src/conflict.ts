import { STEREO_BANDS } from "@audiosous/analysis-contract";
import { fieldShares, imageOf, occupancy, overlapOf, placeStats, type Lrc, type SpatialSetting, type StereoImage } from "./stereo";

/**
 * Spatial conflict between two stems in one scope:
 *
 *   severity = frequency competition × stereo overlap × simultaneous activity
 *
 * Frequency competition is Milestone 4's masked fraction of the more important stem (saturated, 0…1),
 * measured on the mix as it is now: faders, section gain, and saved EQ included. If an EQ cut already
 * separated two stems, this is low and no spatial move is needed.
 *
 * Stereo overlap is weighted by where they compete: in each of the 8 stereo bands, how much the two
 * stems' field distributions coincide, weighted by that band's share of the frequency competition. Two
 * stems that only collide at 2–5 kHz are compared where they sit at 2–5 kHz.
 *
 * Activity is Milestone 4's activity factor (simultaneity and coverage). Stems that never play
 * together have no pair at all.
 */
export interface ConflictInput {
  /** The moving stem's statistics before width and pan, mean over the co-active steps, per band. */
  target: Lrc[];
  /** The other stem as heard, mean over the same steps, per band. */
  other: Lrc[];
  /** Share of the frequency competition in each band, summing to 1. */
  weights: number[];
  frequency: number;
  activity: number;
  mono: boolean;
}

export interface ConflictReading {
  severity: number;
  /** Frequency-weighted overlap of the two stems' field distributions. */
  overlap: number;
  /** Share of the conflict that sits where position can separate parts, 0…1. */
  localizable: number;
  /** Frequency-weighted √(center share × center share): both stems in the middle. */
  centerCompetition: number;
  targetImage: StereoImage;
  otherImage: StereoImage;
}

/** The other stem's field distribution per band. It does not change while one stem's setting is searched, so it is computed once. */
export interface PreparedOther {
  occupancy: Array<number[] | null>;
  center: number[];
}

/**
 * How well a position in the field separates two parts in each stereo band (20–47, 47–112, 112–266,
 * 266–632, 632 Hz–1.5 kHz, 1.5–3.6, 3.6–8.4, 8.4–20 kHz). Level and time differences between the ears
 * localize poorly in the low end, so a conflict that lives under ~250 Hz is not a spatial problem:
 * panning cannot separate it, and low end stays centered. A fixed Audiosous weighting, not a hearing model.
 */
export const LOCALIZABILITY = [0.1, 0.2, 0.45, 0.75, 1, 1, 1, 1];

/** Bands carrying less of the competition than this are skipped. */
const MIN_WEIGHT = 0.005;

export function prepareOther(other: Lrc[], weights: number[]): PreparedOther {
  const out: PreparedOther = { occupancy: [], center: [] };
  for (let band = 0; band < STEREO_BANDS; band += 1) {
    if ((weights[band] ?? 0) < MIN_WEIGHT) {
      out.occupancy.push(null);
      out.center.push(0);
      continue;
    }
    const distribution = occupancy(imageOf(other[band]!));
    out.occupancy.push(distribution);
    out.center.push(fieldShares(distribution).center);
  }
  return out;
}

export function readConflict(input: ConflictInput, setting: SpatialSetting, prepared: PreparedOther = prepareOther(input.other, input.weights)): ConflictReading {
  let overlap = 0;
  let center = 0;
  let localized = 0;
  let localizable = 0;
  const placed: Lrc[] = [];
  for (let band = 0; band < STEREO_BANDS; band += 1) {
    const stats = placeStats(input.target[band]!, setting, input.mono);
    placed.push(stats);
    const weight = input.weights[band] ?? 0;
    const b = prepared.occupancy[band];
    if (weight < MIN_WEIGHT || !b) continue;
    const a = occupancy(imageOf(stats));
    const shared = overlapOf(a, b);
    overlap += weight * shared;
    localized += weight * shared * LOCALIZABILITY[band]!;
    localizable += weight * LOCALIZABILITY[band]!;
    center += weight * Math.sqrt(fieldShares(a).center * prepared.center[band]!);
  }
  return {
    // Only the part of the overlap that position can actually separate counts toward the spatial conflict.
    severity: input.frequency * localized * input.activity,
    overlap,
    localizable,
    centerCompetition: center,
    targetImage: weightedImage(placed, input.weights),
    otherImage: weightedImage(input.other, input.weights),
  };
}

/** The image of the bands that matter for this conflict: statistics summed with the conflict weights. */
export function weightedImage(stats: Lrc[], weights: number[]): StereoImage {
  const sum = { l: 0, r: 0, c: 0 };
  const total = weights.reduce((acc, value) => acc + value, 0);
  stats.forEach((value, band) => {
    const weight = total > 0 ? (weights[band] ?? 0) : 1;
    sum.l += value.l * weight;
    sum.r += value.r * weight;
    sum.c += value.c * weight;
  });
  return imageOf(sum);
}

/** Normalizes per-band weights; falls back to the stem's own energy split when there is no competition. */
export function normalizeWeights(values: number[], fallback: Lrc[]): number[] {
  const total = values.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (total > 0) return values.map((value) => Math.max(0, value) / total);
  const energy = fallback.map((value) => value.l + value.r);
  const sum = energy.reduce((acc, value) => acc + value, 0);
  return sum > 0 ? energy.map((value) => value / sum) : new Array<number>(STEREO_BANDS).fill(1 / STEREO_BANDS);
}
