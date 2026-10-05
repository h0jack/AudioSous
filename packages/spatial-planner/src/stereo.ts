/**
 * Second-order stereo statistics and what width and pan do to them.
 *
 * A stem in one band over some stretch of time is summarized by three numbers: left power E[L²],
 * right power E[R²], and the cross term E[L·R]. From those:
 *
 *   mid power   M = (L + R + 2C) / 4        side power  S = (L + R − 2C) / 4
 *   correlation ρ = C / √(L·R)              balance     b = (R − L) / (R + L)
 *
 * The native spatial stage is linear and static between ramps, so its effect on these averages is
 * exact: width scales the side signal by w (S → w²S, the mid/side cross term by w) and pan/balance
 * scales each channel by its equal-power coefficient. That lets the planner predict a candidate's
 * correlation, mono fold-down, and position from the cached measurement without touching audio.
 * The Rust test `measures_correlation_and_mono_loss_before_and_after_a_width_change` holds the native
 * DSP to these formulas on real proxy audio.
 */

export interface Lrc {
  l: number;
  r: number;
  c: number;
}

export interface SpatialSetting {
  pan: number;
  width: number;
}

export const ZERO_LRC: Lrc = { l: 0, r: 0, c: 0 };
const TINY = 1e-20;

/** The engine's equal-power law: left = √(1 − p), right = √p, p = (pan + 1) / 2. */
export function equalPowerPan(pan: number): [number, number] {
  const position = Math.min(1, Math.max(0, (Math.min(1, Math.max(-1, pan)) + 1) / 2));
  return [Math.sqrt(1 - position), Math.sqrt(position)];
}

export function midPower(stats: Lrc): number {
  return Math.max(0, (stats.l + stats.r + 2 * stats.c) / 4);
}

export function sidePower(stats: Lrc): number {
  return Math.max(0, (stats.l + stats.r - 2 * stats.c) / 4);
}

/** Mean power per channel, (L + R) / 2 = M + S. */
export function stereoPower(stats: Lrc): number {
  return Math.max(0, (stats.l + stats.r) / 2);
}

/**
 * Width, then pan or balance, applied to a stem's statistics. `source` is the stem after gain and EQ and
 * before the spatial stage. A mono stem has L = R = C and ignores width, exactly like the engine.
 */
export function placeStats(source: Lrc, setting: SpatialSetting, mono: boolean): Lrc {
  let { l, r, c } = source;
  const width = Math.min(2, Math.max(0, setting.width));
  if (!mono && width !== 1) {
    const mid = (l + r + 2 * c) / 4;
    const side = (l + r - 2 * c) / 4;
    const cross = (l - r) / 4;
    l = mid + width * width * side + 2 * width * cross;
    r = mid + width * width * side - 2 * width * cross;
    c = mid - width * width * side;
  }
  const [gl, gr] = equalPowerPan(setting.pan);
  return { l: Math.max(0, gl * gl * l), r: Math.max(0, gr * gr * r), c: gl * gr * c };
}

export function addLrc(into: Lrc, value: Lrc, scale = 1): Lrc {
  return { l: into.l + value.l * scale, r: into.r + value.r * scale, c: into.c + value.c * scale };
}

export interface StereoImage {
  /** Where the stem sounds, −1 left … +1 right. A mono stem panned to p reads exactly p. */
  position: number;
  /**
   * Half-width of the image, 0 (a point) … 1 (spans the whole field), from decorrelation: 1 − correlation.
   * Not from the side share, because a mono part panned off center has side energy without being wide.
   * Pan and balance do not change it; width does.
   */
  spread: number;
  /** Share of the stem's energy that is side signal, 0 mono … 0.5 decorrelated … 1 anti-phase. */
  sideShare: number;
  correlation: number;
  /** How much quieter the stem is folded to mono than in stereo, dB. 0 for a mono stem, 3 dB for decorrelated noise. */
  monoLossDb: number;
  /** Side minus mid level, dB. */
  msRatioDb: number;
  power: number;
}

export function imageOf(stats: Lrc): StereoImage {
  const total = stats.l + stats.r;
  const mid = midPower(stats);
  const side = sidePower(stats);
  const power = mid + side;
  if (total <= TINY || power <= TINY) {
    return { position: 0, spread: 0, sideShare: 0, correlation: 1, monoLossDb: 0, msRatioDb: -60, power: 0 };
  }
  const balance = clamp((stats.r - stats.l) / total, -1, 1);
  const norm = Math.sqrt(Math.max(0, stats.l) * Math.max(0, stats.r));
  const sideShare = clamp(side / power, 0, 1);
  const correlation = norm > TINY ? clamp(stats.c / norm, -1, 1) : 1;
  return {
    // The engine's pan law splits power linearly ((1 − p), p), so a centered stem panned to x has energy balance x.
    position: balance,
    spread: clamp(1 - correlation, 0, 1),
    sideShare,
    correlation,
    monoLossDb: Math.min(40, 10 * Math.log10(power / Math.max(mid, power * 1e-4))),
    msRatioDb: Math.max(-60, 10 * Math.log10(Math.max(side, power * 1e-6) / Math.max(mid, power * 1e-6))),
    power,
  };
}

/* ------------------------------------------------------------------ occupancy */

/**
 * Where a stem lives across the stereo field, as a distribution over 41 positions from −1 to +1.
 * The point part (1 − spread) is a narrow bump at the stem's position, the localization blur of a
 * panned source. The diffuse part (spread) is spread evenly over the image span. This is an Audiosous
 * description for comparing stems, not a model of binaural localization.
 */
export const OCCUPANCY_BINS = 41;
const BIN_X = Array.from({ length: OCCUPANCY_BINS }, (_, index) => -1 + (2 * index) / (OCCUPANCY_BINS - 1));
/** Localization blur of a point source, in pan units. Two point sources 25% apart overlap about 0.12. */
const POINT_SIGMA = 0.08;
const CENTER_HALF_WIDTH = 0.25;

export function binPositions(): number[] {
  return [...BIN_X];
}

export function occupancy(image: Pick<StereoImage, "position" | "spread">): number[] {
  const out = new Array<number>(OCCUPANCY_BINS).fill(0);
  const point = 1 - image.spread;
  if (point > 0) {
    // Only bins within four blur widths carry weight worth computing.
    const step = 2 / (OCCUPANCY_BINS - 1);
    const first = Math.max(0, Math.floor((image.position - 4 * POINT_SIGMA + 1) / step));
    const last = Math.min(OCCUPANCY_BINS - 1, Math.ceil((image.position + 4 * POINT_SIGMA + 1) / step));
    let total = 0;
    for (let index = first; index <= last; index += 1) {
      const value = Math.exp(-0.5 * ((BIN_X[index]! - image.position) / POINT_SIGMA) ** 2);
      out[index] = value;
      total += value;
    }
    const scale = point / Math.max(total, TINY);
    for (let index = first; index <= last; index += 1) out[index]! *= scale;
  }
  if (image.spread > 0) {
    const low = Math.max(-1, image.position - image.spread);
    const high = Math.min(1, image.position + image.spread);
    const inside = BIN_X.map((x) => (x >= low - 0.025 && x <= high + 0.025 ? 1 : 0));
    const count = inside.reduce((sum: number, value) => sum + value, 0);
    inside.forEach((value, index) => (out[index]! += (image.spread * value) / Math.max(count, 1)));
  }
  return out;
}

/** Shares of the distribution in the center (|x| ≤ 0.25), left, and right. */
export function fieldShares(distribution: number[]): { center: number; left: number; right: number } {
  let center = 0;
  let left = 0;
  let right = 0;
  distribution.forEach((value, index) => {
    const x = BIN_X[index]!;
    if (Math.abs(x) <= CENTER_HALF_WIDTH + 1e-9) center += value;
    else if (x < 0) left += value;
    else right += value;
  });
  return { center, left, right };
}

/** Histogram intersection, 0 (nowhere together) … 1 (the same place). */
export function overlapOf(left: number[], right: number[]): number {
  let shared = 0;
  for (let index = 0; index < OCCUPANCY_BINS; index += 1) shared += Math.min(left[index] ?? 0, right[index] ?? 0);
  return clamp(shared, 0, 1);
}

/** Level change of a stem's stereo power when its width changes, from its own statistics. */
export function widthLevelChangeDb(source: Lrc, fromWidth: number, toWidth: number, mono: boolean): number {
  if (mono) return 0;
  const before = stereoPower(placeStats(source, { pan: 0, width: fromWidth }, false));
  const after = stereoPower(placeStats(source, { pan: 0, width: toWidth }, false));
  if (before <= TINY || after <= TINY) return 0;
  return 10 * Math.log10(after / before);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
