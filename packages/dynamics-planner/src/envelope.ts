import { decodeEnvelopeSeries, ENVELOPE_FLOOR_DB, type EnvelopeFrames, type EqBandFrames } from "@audiosous/analysis-contract";
import { bandPowerGain } from "@audiosous/eq-planner";
import { eqChainForSection, type ProjectDocument, type SongSection, type Track } from "@audiosous/project-model";

/**
 * Every stem's level over time as the mix is now, on one 10 ms grid.
 *
 * The raw series come from the playback proxy (`EnvelopeFrames`): stereo-linked RMS, peak, and the low band
 * (< 150 Hz). What a listener hears differs from the raw stem by the fader or section gain, by the saved EQ, and
 * by saved dynamics. Gains and EQ are static inside a segment (a section or the time between sections), so they
 * are kept as per-segment offsets: the fader or section gain, the saved EQ's average power response over the
 * stem's spectrum (broadband) and over 40–150 Hz (low band). Saved dynamics are time-varying; the planner
 * simulates them on top (see simulate.ts).
 *
 * Nothing here decides a move.
 */
export const HOP_SECONDS = 0.01;
/** 50 ms cells and 400 ms sustained-level windows, the same definitions the Rust proxy check uses. */
export const CELL_FRAMES = 5;
export const WINDOW_CELLS = 8;
const PLAYING_RANGE_DB = 30;
const PLAYING_FLOOR_DB = -60;

export interface Segment {
  start: number;
  end: number;
  sectionId: string | null;
  /** Fader, or the section's gain override. */
  gainDb: number;
  /** Saved EQ (track + section nodes): change of the broadband and the low-band level, dB. */
  eqBroadDb: number;
  eqLowDb: number;
}

export interface EnvelopeTrack {
  track: Track;
  frames: number;
  rms: Float32Array;
  peak: Float32Array;
  low: Float32Array;
  segments: Segment[];
  /** Loudest 50 ms cell of the raw stem, dB. Cells within 30 dB of it (and above −60 dBFS) count as playing. */
  loudestCellDb: number;
}

export interface EnvelopeModel {
  frames: number;
  durationSeconds: number;
  tracks: Map<string, EnvelopeTrack>;
  skipped: Array<{ trackId: string; reason: "muted" | "unmeasured" }>;
}

export interface BuildEnvelopeInput {
  document: ProjectDocument;
  envelopes: Record<string, EnvelopeFrames | null | undefined>;
  /** Proxy band frames weight the saved EQ's broadband effect by the stem's own spectrum. Optional. */
  bands?: Record<string, EqBandFrames | null | undefined>;
}

export function buildEnvelopeModel(input: BuildEnvelopeInput): EnvelopeModel {
  const { document } = input;
  const durationSeconds = Math.max(HOP_SECONDS, document.project.durationSeconds);
  const frames = Math.ceil(durationSeconds / HOP_SECONDS);
  const tracks = new Map<string, EnvelopeTrack>();
  const skipped: EnvelopeModel["skipped"] = [];
  for (const track of document.tracks) {
    if (track.muted) {
      skipped.push({ trackId: track.id, reason: "muted" });
      continue;
    }
    const envelope = input.envelopes[track.id];
    if (!envelope) {
      skipped.push({ trackId: track.id, reason: "unmeasured" });
      continue;
    }
    const rms = fit(decodeEnvelopeSeries(envelope.rms), frames);
    const peak = fit(decodeEnvelopeSeries(envelope.peak), frames);
    const low = fit(decodeEnvelopeSeries(envelope.low), frames);
    tracks.set(track.id, {
      track,
      frames,
      rms,
      peak,
      low,
      segments: segmentsFor(document, track, frames, input.bands?.[track.id] ?? null),
      loudestCellDb: loudestCell(rms),
    });
  }
  return { frames, durationSeconds, tracks, skipped };
}

function fit(values: Float32Array, frames: number): Float32Array {
  if (values.length === frames) return values;
  const out = new Float32Array(frames).fill(ENVELOPE_FLOOR_DB);
  out.set(values.subarray(0, Math.min(values.length, frames)));
  return out;
}

/** Segments of the song: each section, and the time outside sections. Static gain and EQ hold inside each. */
function segmentsFor(document: ProjectDocument, track: Track, frames: number, bands: EqBandFrames | null): Segment[] {
  const ordered = [...document.sections].sort((left, right) => left.startTime - right.startTime);
  const out: Segment[] = [];
  let cursor = 0;
  const push = (start: number, end: number, section: SongSection | null) => {
    if (end <= start) return;
    const row = section ? document.sectionTrackSettings.find((item) => item.trackId === track.id && item.sectionId === section.id) : undefined;
    const filters = eqChainForSection(document, track.id, section?.id ?? null);
    out.push({
      start,
      end,
      sectionId: section?.id ?? null,
      gainDb: row?.overrides.gainDb ?? track.gainDb,
      eqBroadDb: broadEqDb(filters, bands),
      eqLowDb: 10 * Math.log10(Math.max(1e-12, bandPowerGain(filters, 40, 150))),
    });
  };
  for (const section of ordered) {
    const start = Math.min(frames, Math.max(0, Math.round(section.startTime / HOP_SECONDS)));
    const end = Math.min(frames, Math.max(0, Math.round(section.endTime / HOP_SECONDS)));
    push(cursor, start, null);
    push(Math.max(cursor, start), end, section);
    cursor = Math.max(cursor, end);
  }
  push(cursor, frames, null);
  return out;
}

/** The saved EQ's change of a stem's overall level, weighted by the stem's average spectrum (flat without bands). */
function broadEqDb(filters: ReturnType<typeof eqChainForSection>, bands: EqBandFrames | null): number {
  if (filters.length === 0) return 0;
  const weights = new Array<number>(24).fill(1);
  if (bands && bands.frames.length > 0) {
    weights.fill(0);
    for (const row of bands.frames) row.forEach((db, band) => (weights[band]! += 10 ** (db / 10)));
  }
  let before = 0;
  let after = 0;
  for (let band = 0; band < 24; band += 1) {
    const low = bands?.edgesHz[band] ?? 20 * 1_000 ** (band / 24);
    const high = bands?.edgesHz[band + 1] ?? 20 * 1_000 ** ((band + 1) / 24);
    before += weights[band]!;
    after += weights[band]! * bandPowerGain(filters, low, high, 3);
  }
  return before > 0 && after > 0 ? 10 * Math.log10(after / before) : 0;
}

function loudestCell(rms: Float32Array): number {
  let loudest = -Infinity;
  for (let start = 0; start + CELL_FRAMES <= rms.length; start += CELL_FRAMES) loudest = Math.max(loudest, cellDb(rms, start));
  return Number.isFinite(loudest) ? loudest : ENVELOPE_FLOOR_DB;
}

export function segmentAt(track: EnvelopeTrack, frame: number): Segment {
  for (const segment of track.segments) if (frame >= segment.start && frame < segment.end) return segment;
  return track.segments[track.segments.length - 1]!;
}

/** Power mean of `count` frames of a dB series, in dB. */
export function meanDb(series: ArrayLike<number>, start: number, count: number): number {
  let total = 0;
  let used = 0;
  for (let frame = start; frame < start + count && frame < series.length; frame += 1) {
    total += 10 ** (series[frame]! / 10);
    used += 1;
  }
  return used > 0 ? 10 * Math.log10(Math.max(total / used, 1e-20)) : ENVELOPE_FLOOR_DB;
}

export function cellDb(series: ArrayLike<number>, start: number): number {
  return meanDb(series, start, CELL_FRAMES);
}

export interface SustainedLevels {
  /** Window start frames and their sustained level (median playing cell), dB. */
  starts: number[];
  levels: number[];
}

/**
 * Sustained level per 400 ms window: the median of the window's playing 50 ms cells, when at least 5 of 8 play.
 * `series` is the level to read (raw, heard, or simulated); `reference` decides which cells play (the raw RMS).
 */
export function sustainedLevels(series: ArrayLike<number>, reference: ArrayLike<number>, loudestCellDb: number, start: number, end: number): SustainedLevels {
  const span = CELL_FRAMES * WINDOW_CELLS;
  const first = Math.ceil(start / CELL_FRAMES) * CELL_FRAMES;
  const starts: number[] = [];
  const levels: number[] = [];
  for (let window = first; window + span <= end; window += span) {
    const playing: number[] = [];
    for (let cell = 0; cell < WINDOW_CELLS; cell += 1) {
      const at = window + cell * CELL_FRAMES;
      const ref = cellDb(reference, at);
      if (ref > PLAYING_FLOOR_DB && ref >= loudestCellDb - PLAYING_RANGE_DB) playing.push(cellDb(series, at));
    }
    if (playing.length * 8 < WINDOW_CELLS * 5) continue;
    playing.sort((left, right) => left - right);
    starts.push(window);
    levels.push(playing[Math.floor(playing.length / 2)]!);
  }
  return { starts, levels };
}

export function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return ENVELOPE_FLOOR_DB;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.round((sorted.length - 1) * share)]!;
}

export interface SpreadReading {
  windows: number;
  p10: number;
  p50: number;
  p90: number;
  /** p90 − p10, dB. */
  spreadDb: number;
  /** Share of consecutive window pairs that jump by more than the swing threshold. */
  swingRate: number;
}

export function spreadOf(levels: SustainedLevels, swingDb: number): SpreadReading {
  const p10 = percentile(levels.levels, 0.1);
  const p50 = percentile(levels.levels, 0.5);
  const p90 = percentile(levels.levels, 0.9);
  let steps = 0;
  let swings = 0;
  const span = CELL_FRAMES * WINDOW_CELLS;
  for (let index = 1; index < levels.levels.length; index += 1) {
    if (levels.starts[index]! - levels.starts[index - 1]! !== span) continue;
    steps += 1;
    if (Math.abs(levels.levels[index]! - levels.levels[index - 1]!) > swingDb) swings += 1;
  }
  return { windows: levels.levels.length, p10, p50, p90, spreadDb: p90 - p10, swingRate: steps > 0 ? swings / steps : 0 };
}

export interface SelfSimilarity {
  /**
   * The level's mean difference from itself one lag earlier, at the lag that repeats best (0.4–8 s), divided by the
   * same difference at a typical lag. Near 0: the level repeats exactly with the music (a stutter, a gated or pumped
   * pad, a sequenced bass line). Near 1: it does not repeat at all, like uneven playing.
   */
  ratio: number;
  /** The lag that repeats best, seconds. */
  lagSeconds: number;
}

/** Half-width of the self-similarity smoothing: 20 frames each side, a 400 ms moving average. */
const SMOOTH_HALF = 20;

/**
 * Self-similarity of a stem's sustained level over [start, end): its 400 ms moving average at 10 ms resolution,
 * so a rhythmic texture inside a beat does not hide uneven level from note to note. Lags step
 * 20 ms and every 4th frame is compared, which keeps a 6-minute song to a few million comparisons. Only frames where
 * the stem plays (by `reference`) count. Tempo-free: a bar of any length shows up as its own lag.
 */
export function selfSimilarity(series: ArrayLike<number>, reference: ArrayLike<number>, loudestCellDb: number, start: number, end: number): SelfSimilarity {
  const count = Math.max(0, end - start);
  const level = new Float32Array(count);
  const playing = new Uint8Array(count);
  // Running sums give the 400 ms moving average (the sustained-level timescale) in one pass.
  const power = new Float64Array(count + 1);
  const referencePower = new Float64Array(count + 1);
  for (let index = 0; index < count; index += 1) {
    power[index + 1] = power[index]! + 10 ** (series[start + index]! / 10);
    referencePower[index + 1] = referencePower[index]! + 10 ** (reference[start + index]! / 10);
  }
  for (let index = 0; index < count; index += 1) {
    const low = Math.max(0, index - SMOOTH_HALF);
    const high = Math.min(count, index + SMOOTH_HALF + 1);
    level[index] = 10 * Math.log10(Math.max((power[high]! - power[low]!) / (high - low), 1e-20));
    const referenceDb = 10 * Math.log10(Math.max((referencePower[high]! - referencePower[low]!) / (high - low), 1e-20));
    playing[index] = referenceDb > -60 && referenceDb >= loudestCellDb - 30 ? 1 : 0;
  }
  const differences: Array<{ lag: number; value: number }> = [];
  for (let lag = 40; lag <= Math.min(800, Math.floor(count / 3)); lag += 2) {
    let total = 0;
    let used = 0;
    for (let index = lag; index < count; index += 4) {
      if (playing[index] !== 1 || playing[index - lag] !== 1) continue;
      total += Math.min(15, Math.abs(level[index]! - level[index - lag]!));
      used += 1;
    }
    if (used >= 50) differences.push({ lag, value: total / used });
  }
  if (differences.length < 5) return { ratio: 1, lagSeconds: 0 };
  const best = differences.reduce((left, right) => (right.value < left.value - 1e-9 ? right : left));
  const typical = percentile(differences.map((item) => item.value), 0.5);
  return { ratio: typical > 0 ? best.value / typical : 1, lagSeconds: best.lag * HOP_SECONDS };
}

/**
 * Onsets in a 10 ms peak series: a frame 9 dB over the quietest of the previous three, within 40 dB of the stem's
 * loudest peak and above −50 dBFS, at least 60 ms after the previous onset.
 */
export function onsetsOf(peak: ArrayLike<number>, start: number, end: number): number[] {
  let loudest = -Infinity;
  for (let frame = start; frame < end; frame += 1) loudest = Math.max(loudest, peak[frame]!);
  const floor = Math.max(-50, loudest - 40);
  const out: number[] = [];
  let last = -Infinity;
  for (let frame = Math.max(start, 3); frame < end; frame += 1) {
    const value = peak[frame]!;
    if (value < floor) continue;
    const before = Math.min(peak[frame - 1]!, peak[frame - 2]!, peak[frame - 3]!);
    if (value - before >= 9 && frame - last >= 6) {
      out.push(frame);
      last = frame;
    }
  }
  return out;
}

/** Attack energy (the onset frame and the next) over body energy (40–140 ms), dB, from 10 ms RMS. */
export function transientRatioDb(rms: ArrayLike<number>, onset: number): number | null {
  if (onset + 14 > rms.length) return null;
  const attack = meanDb(rms, onset, 2);
  const body = meanDb(rms, onset + 4, 10);
  return attack - body;
}

export function frameOf(seconds: number): number {
  return Math.max(0, Math.round(seconds / HOP_SECONDS));
}
