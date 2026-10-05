import { HOP_SECONDS } from "./envelope";

/**
 * The native dynamics, run on 10 ms envelopes instead of samples. Same static curve, same detectors, the same
 * 6 dB key span and attack/release smoothing on the reduction (crates/audio-engine/src/dynamics.rs), at 10 ms
 * resolution. It is what the planner sizes moves with and what an edit is re-checked with; the proxy check then
 * runs the real DSP on real audio. Inside a 10 ms frame nothing is resolved, so a fast attack's effect on the
 * first milliseconds of a hit is beyond this model.
 */
export const KEY_SPAN_DB = 6;
export const MAX_REDUCTION_DB = 30;
const STEP_MS = HOP_SECONDS * 1_000;
const KEY_PEAK_FALL_DB = (STEP_MS / 30) * (20 / Math.LN10);
const KEY_SMOOTH_MS = 50;

export interface CompressorParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeDb: number;
  makeupDb: number;
}

export interface DuckingParams {
  thresholdDb: number;
  rangeDb: number;
  attackMs: number;
  releaseMs: number;
  keyDetector: "transient" | "smooth";
}

export interface DynamicEqParams {
  thresholdDb: number;
  rangeDb: number;
  attackMs: number;
  releaseMs: number;
}

/** Soft-knee gain reduction in dB (≥ 0), the Rust `reduction_db`. */
export function reductionDb(levelDb: number, thresholdDb: number, ratio: number, kneeDb: number): number {
  const over = levelDb - thresholdDb;
  const slope = 1 - 1 / Math.max(1, ratio);
  if (kneeDb > 0 && 2 * Math.abs(over) <= kneeDb) return (slope * (over + kneeDb / 2) ** 2) / (2 * kneeDb);
  return over > 0 ? slope * over : 0;
}

function coefficient(ms: number, stepMs: number): number {
  return 1 - Math.exp(-stepMs / Math.max(0.05, ms));
}

/**
 * Per-frame gain reduction of a compressor whose detector sees `detectorDb` (the stem's 10 ms RMS after its EQ,
 * before the fader), over frames [start, end).
 */
export function simulateCompressor(detectorDb: ArrayLike<number>, params: CompressorParams, start = 0, end = detectorDb.length): Float32Array {
  const out = new Float32Array(Math.max(0, end - start));
  const attack = coefficient(params.attackMs, STEP_MS);
  const release = coefficient(params.releaseMs, STEP_MS);
  let reduction = 0;
  for (let frame = start; frame < end; frame += 1) {
    const target = Math.min(MAX_REDUCTION_DB, reductionDb(detectorDb[frame]!, params.thresholdDb, params.ratio, params.kneeDb));
    reduction += (target > reduction ? attack : release) * (target - reduction);
    out[frame - start] = reduction;
  }
  return out;
}

/**
 * Per-frame duck (dB ≥ 0) from a key track's raw 10 ms peak (transient key: instant rise, 30 ms fall) or RMS
 * (smooth key: 50 ms average), over frames [start, end).
 */
export function simulateDucking(keyPeakDb: ArrayLike<number>, keyRmsDb: ArrayLike<number>, params: DuckingParams, start = 0, end = keyPeakDb.length): Float32Array {
  const out = new Float32Array(Math.max(0, end - start));
  const attack = coefficient(params.attackMs, STEP_MS);
  const release = coefficient(params.releaseMs, STEP_MS);
  const smooth = coefficient(KEY_SMOOTH_MS, STEP_MS);
  let envelope = -200;
  let power = 0;
  let reduction = 0;
  const depth = Math.max(0, -params.rangeDb);
  for (let frame = start; frame < end; frame += 1) {
    let keyDb: number;
    if (params.keyDetector === "smooth") {
      power += smooth * (10 ** (keyRmsDb[frame]! / 10) - power);
      keyDb = 10 * Math.log10(Math.max(power, 1e-20));
    } else {
      envelope = Math.max(keyPeakDb[frame]!, envelope - KEY_PEAK_FALL_DB);
      keyDb = envelope;
    }
    const activation = Math.min(1, Math.max(0, (keyDb - params.thresholdDb) / KEY_SPAN_DB));
    const target = depth * activation;
    reduction += (target > reduction ? attack : release) * (target - reduction);
    out[frame - start] = reduction;
  }
  return out;
}

/** Per-step activation (0…1) of a dynamic EQ from its detector's band level per step (`stepSeconds` apart). */
export function simulateDynamicEq(detectorBandDb: readonly number[], params: DynamicEqParams, stepSeconds: number): number[] {
  const attack = coefficient(params.attackMs, stepSeconds * 1_000);
  const release = coefficient(params.releaseMs, stepSeconds * 1_000);
  let activation = 0;
  return detectorBandDb.map((level) => {
    const target = Math.min(1, Math.max(0, (level - params.thresholdDb) / KEY_SPAN_DB));
    activation += (target > activation ? attack : release) * (target - activation);
    return activation;
  });
}

/**
 * How much a transient shaper changes one hit, from the hit's rise (its 10 ms peak over the quietest of the
 * previous 30 ms), as average gain over the attack (first 10 ms) and the body (40–140 ms). From the native
 * envelopes on their 12 ms held level: a hit rising 20 dB or more gets about 9–11 dB of attack reading over its
 * first 10 ms, a 9 dB rise about 4 dB; the body carries about 1.5 dB per unit of attack amount (a −15% clap body
 * measured −0.24 dB) and, after a sharp hit, a large sustain reading.
 */
export function transientGainDb(riseDb: number, attack: number, sustain: number): { attackDb: number; bodyDb: number } {
  const rise = Math.max(0, riseDb);
  const attackReading = Math.min(9, 0.45 * rise);
  const sustainReading = Math.min(10, 0.5 * rise);
  return { attackDb: attack * attackReading, bodyDb: attack * 1.5 + sustain * sustainReading };
}

/** Largest value per bucket, for drawing a reduction over time with at most `points` points. */
export function downsampleMax(values: ArrayLike<number>, points: number): number[] {
  if (values.length === 0) return [];
  const buckets = Math.min(points, values.length);
  const out: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = Math.floor((bucket * values.length) / buckets);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * values.length) / buckets));
    let largest = 0;
    for (let at = from; at < to; at += 1) largest = Math.max(largest, values[at]!);
    out.push(Math.round(largest * 100) / 100);
  }
  return out;
}
