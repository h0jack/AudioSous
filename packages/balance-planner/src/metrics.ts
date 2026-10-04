import type { BandEnergy, TrackFileMeasurement } from "@audiosous/analysis-contract";

/** Levels derived from a cached measurement. These are facts for the planner, not targets. */
export interface BalanceMetrics {
  activeRmsDbfs: number | null;
  /**
   * Active RMS shifted by the stem's own K-weighting offset (integrated LUFS minus whole-file active RMS).
   * Unweighted RMS ranks a sub-heavy bass far above a bright lead that sounds as loud; this is what the planner compares.
   * Falls back to active RMS when the file has no measured loudness.
   */
  activeLevelDb: number | null;
  loudnessWeighted: boolean;
  medianActiveLevel: number | null;
  p75ActiveLevel: number | null;
  activePercent: number;
  activeSeconds: number;
  crestFactorDb: number | null;
  peakDbfs: number | null;
  lowBandShare: number;
  durationSeconds: number;
  metricsAgree: boolean;
}

const ACTIVE_RANGE_DB = 18;
const ACTIVE_FLOOR_DB = -55;
const LOUDNESS_OFFSET_LIMIT_DB = 8;

export function balanceMetrics(
  measurement: TrackFileMeasurement | null | undefined,
  window?: { start: number; end: number },
): BalanceMetrics | null {
  if (!measurement) return null;
  const duration = window ? Math.max(0, window.end - window.start) : measurement.source.durationSeconds;
  const points = timelinePoints(measurement, window);
  const finite = points.filter((value): value is number => value !== null && Number.isFinite(value));
  const peak = finite.length > 0 ? Math.max(...finite) : null;
  const active = finite.filter((value) => value >= ACTIVE_FLOOR_DB && (peak === null || value >= peak - ACTIVE_RANGE_DB));
  const dedicatedWindow = window === undefined || measurementCovers(measurement, window);
  let activeRms: number | null = null;
  let medianActive: number | null = null;
  let p75: number | null = null;
  let activePercent = measurement.dynamics.activePercent;
  if (active.length >= 2) {
    activeRms = powerMeanDb(active);
    medianActive = percentile(active, 0.5);
    p75 = percentile(active, 0.75);
    activePercent = (active.length / Math.max(1, finite.length)) * 100;
  } else if (dedicatedWindow && measurement.levels.rmsDbfs !== null && measurement.dynamics.activePercent >= 20) {
    activeRms = measurement.levels.rmsDbfs;
    medianActive = measurement.levels.rmsDbfs;
    p75 = measurement.levels.rmsDbfs;
    activePercent = measurement.dynamics.activePercent;
  } else if (window && finite.length > 0 && measurement.levels.rmsDbfs !== null) {
    activePercent = finite.length === 0 ? 0 : (active.length / finite.length) * 100;
  }
  if (window && finite.length === 0 && !dedicatedWindow) {
    activePercent = 0;
    activeRms = null;
  }
  const metricsAgree =
    activeRms !== null &&
    medianActive !== null &&
    p75 !== null &&
    Math.abs(activeRms - medianActive) <= 2.5 &&
    Math.abs(activeRms - p75) <= 4;
  const offset = loudnessOffsetDb(measurement);
  return {
    activeRmsDbfs: activeRms,
    activeLevelDb: activeRms === null ? null : activeRms + (offset ?? 0),
    loudnessWeighted: offset !== null,
    medianActiveLevel: medianActive,
    p75ActiveLevel: p75,
    activePercent,
    activeSeconds: (activePercent / 100) * duration,
    crestFactorDb: measurement.levels.crestFactorDb,
    peakDbfs: measurement.levels.peakDbfs,
    lowBandShare: lowBandShare(measurement.bandEnergy),
    durationSeconds: duration,
    metricsAgree,
  };
}

export function lowBandOverlap(left: BandEnergy[] | null | undefined, right: BandEnergy[] | null | undefined): number {
  if (!left || !right) return 0;
  const ids = ["sub", "bass", "low-mid"] as const;
  let sum = 0;
  for (const id of ids) {
    const a = left.find((band) => band.id === id)?.normalizedEnergy ?? 0;
    const b = right.find((band) => band.id === id)?.normalizedEnergy ?? 0;
    sum += Math.min(a, b);
  }
  return sum / ids.length;
}

export function lowBandShare(bands: BandEnergy[]): number {
  const ids = new Set(["sub", "bass", "low-mid"]);
  const chosen = bands.filter((band) => ids.has(band.id));
  if (chosen.length === 0) return 0;
  return chosen.reduce((sum, band) => sum + band.normalizedEnergy, 0) / chosen.length;
}

function loudnessOffsetDb(measurement: TrackFileMeasurement): number | null {
  const lufs = measurement.levels.integratedLufs;
  if (lufs === null || measurement.levels.integratedLufsStatus !== "measured") return null;
  const finite = timelinePoints(measurement).filter((value): value is number => value !== null && Number.isFinite(value));
  const peak = finite.length > 0 ? Math.max(...finite) : null;
  const active = finite.filter((value) => value >= ACTIVE_FLOOR_DB && (peak === null || value >= peak - ACTIVE_RANGE_DB));
  const reference = active.length >= 2 ? powerMeanDb(active) : measurement.levels.rmsDbfs;
  if (reference === null) return null;
  return Math.max(-LOUDNESS_OFFSET_LIMIT_DB, Math.min(LOUDNESS_OFFSET_LIMIT_DB, lufs - reference));
}

function measurementCovers(measurement: TrackFileMeasurement, window: { start: number; end: number }): boolean {
  const span = window.end - window.start;
  return Math.abs(measurement.source.durationSeconds - span) <= Math.max(0.25, span * 0.05);
}

function timelinePoints(measurement: TrackFileMeasurement, window?: { start: number; end: number }): Array<number | null> {
  const points = measurement.loudnessTimeline.filter((point) => {
    if (!window) return true;
    return point.timeSeconds >= window.start && point.timeSeconds < window.end;
  });
  if (points.length > 0) return points.map((point) => point.rmsDbfs);
  if (!window) return [];
  return [];
}

function powerMeanDb(values: number[]): number {
  const power = values.reduce((sum, value) => sum + 10 ** (value / 10), 0) / values.length;
  return 10 * Math.log10(Math.max(power, 1e-12));
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index] ?? 0;
}
