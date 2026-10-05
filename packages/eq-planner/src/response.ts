import { isPassFilter, type EqFilter } from "@audiosous/project-model";

/**
 * Magnitude responses of the stored filters. These are the RBJ Audio EQ Cookbook biquads,
 * the same responses the native engine runs (its Rust tests hold the filters to this formula).
 * Responses are taken at the 48 kHz playback rate; the planner, the curve drawing, and the
 * spectral evaluation all use this one function.
 */
export const RESPONSE_SAMPLE_RATE = 48_000;

export function filterMagnitudeDb(filter: EqFilter, hz: number, sampleRate = RESPONSE_SAMPLE_RATE): number {
  const nyquistGuard = sampleRate * 0.45;
  const f0 = Math.min(Math.max(filter.frequencyHz, 20), Math.min(20_000, nyquistGuard));
  const q = Math.min(10, Math.max(0.1, filter.q));
  const gainDb = isPassFilter(filter.kind) ? 0 : filter.gainDb;
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const sin = Math.sin(w0);
  const cos = Math.cos(w0);
  const alpha = sin / (2 * q);
  const a = 10 ** (gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (filter.kind) {
    case "low-pass":
      [b0, b1, b2, a0, a1, a2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
      break;
    case "high-pass":
      [b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
      break;
    case "bell":
      [b0, b1, b2, a0, a1, a2] = [1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a];
      break;
    case "low-shelf": {
      const root = 2 * Math.sqrt(a) * alpha;
      [b0, b1, b2, a0, a1, a2] = [
        a * (a + 1 - (a - 1) * cos + root),
        2 * a * (a - 1 - (a + 1) * cos),
        a * (a + 1 - (a - 1) * cos - root),
        a + 1 + (a - 1) * cos + root,
        -2 * (a - 1 + (a + 1) * cos),
        a + 1 + (a - 1) * cos - root,
      ];
      break;
    }
    case "high-shelf": {
      const root = 2 * Math.sqrt(a) * alpha;
      [b0, b1, b2, a0, a1, a2] = [
        a * (a + 1 + (a - 1) * cos + root),
        -2 * a * (a - 1 + (a + 1) * cos),
        a * (a + 1 + (a - 1) * cos - root),
        a + 1 - (a - 1) * cos + root,
        2 * (a - 1 - (a + 1) * cos),
        a + 1 - (a - 1) * cos - root,
      ];
      break;
    }
  }
  const w = (2 * Math.PI * Math.min(hz, sampleRate / 2 - 1)) / sampleRate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const numRe = b0 + b1 * c1 + b2 * c2;
  const numIm = -(b1 * s1 + b2 * s2);
  const denRe = a0 + a1 * c1 + a2 * c2;
  const denIm = -(a1 * s1 + a2 * s2);
  const power = (numRe * numRe + numIm * numIm) / Math.max(1e-24, denRe * denRe + denIm * denIm);
  return 10 * Math.log10(Math.max(power, 1e-24));
}

export function chainMagnitudeDb(filters: readonly EqFilter[], hz: number): number {
  let sum = 0;
  for (const filter of filters) sum += filterMagnitudeDb(filter, hz);
  return sum;
}

/**
 * Power gain averaged across a log-spaced band, as a linear factor.
 * A measured band power times this is the band power after the filters, for a static filter
 * and a spectrum that is smooth inside the band. That is the whole evaluation model.
 */
export function bandPowerGain(filters: readonly EqFilter[], lowHz: number, highHz: number, points = 5): number {
  if (filters.length === 0) return 1;
  let sum = 0;
  for (let index = 0; index < points; index += 1) {
    const hz = lowHz * (highHz / lowHz) ** ((index + 0.5) / points);
    sum += 10 ** (chainMagnitudeDb(filters, hz) / 10);
  }
  return sum / points;
}

/** Log-spaced curve for drawing, 20 Hz to 20 kHz. */
export function responseCurve(filters: readonly EqFilter[], points = 120): Array<{ hz: number; db: number }> {
  return Array.from({ length: points }, (_, index) => {
    const hz = 20 * 1_000 ** (index / (points - 1));
    return { hz, db: chainMagnitudeDb(filters, hz) };
  });
}

/** Bandwidth in octaves between the -3 dB points of a bell is about this for a given Q. */
export function octavesForQ(q: number): number {
  const inner = 1 / (2 * q);
  return (2 / Math.log(2)) * Math.asinh(inner);
}

export function qForOctaves(octaves: number): number {
  const half = (Math.log(2) / 2) * octaves;
  return 1 / (2 * Math.sinh(half));
}
