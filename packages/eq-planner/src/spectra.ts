import type { EqBandFrames, TrackFileMeasurement } from "@audiosous/analysis-contract";
import type { EqFilter, ProjectDocument, SongSection, Track } from "@audiosous/project-model";
import { bandPowerGain } from "./response";

/**
 * Time-resolved spectra for every audible track, on one project time grid.
 *
 * Source: the cached analysis spectrogram (24 log bands, 20 Hz – 20 kHz, up to 80 columns per stem).
 * Each value is band power from the stem file, then shifted by the current fader, the Track × Section
 * gain override where one applies, and the response of the EQ already saved on the project.
 * Adding a gain in dB to a power in dB, and multiplying a band power by a filter's averaged power
 * response, are both exact for a static gain and close for a static filter on a smooth spectrum.
 * Nothing here decides a move.
 */
export const GRID_BANDS = 24;
export const GRID_LOW_HZ = 20;
export const GRID_HIGH_HZ = 20_000;
const POWER_FLOOR = 1e-20;
const ACTIVE_RANGE_DB = 30;
const ACTIVE_FLOOR_DB = -65;
const AUDIBLE_FLOOR_DB = -80;
const MAX_STEPS = 360;
const MIN_STEP_SECONDS = 0.25;

export interface BandGrid {
  edges: number[];
  centers: number[];
}

export function bandGrid(): BandGrid {
  const edges = Array.from({ length: GRID_BANDS + 1 }, (_, index) => GRID_LOW_HZ * (GRID_HIGH_HZ / GRID_LOW_HZ) ** (index / GRID_BANDS));
  const centers = edges.slice(0, -1).map((low, index) => Math.sqrt(low * edges[index + 1]!));
  return { edges, centers };
}

export interface TrackSpectra {
  track: Track;
  /** steps × GRID_BANDS linear band power, as heard (fader, section gain, saved EQ). */
  power: Float64Array;
  /** Band power before the fader and EQ, for activity only. */
  active: Uint8Array;
  /** Whole-file 48-bin spectrum (dB) with the saved track-wide EQ, for placing a filter inside a region. */
  fineSpectrum: Array<{ hz: number; db: number }>;
  measurement: TrackFileMeasurement;
  /** Which measurement the band levels came from. */
  source: "proxy-bands" | "spectrogram";
  /** -1 left … +1 right, from the pan control and the measured balance. */
  position: number;
  width: number;
}

export interface SpectralModel {
  grid: BandGrid;
  stepSeconds: number;
  steps: number;
  durationSeconds: number;
  tracks: Map<string, TrackSpectra>;
  /** Tracks that were muted or had no usable measurement. */
  skipped: Array<{ trackId: string; reason: "muted" | "unmeasured" }>;
}

export interface BuildModelInput {
  document: ProjectDocument;
  measurements: Record<string, TrackFileMeasurement | null | undefined>;
  /** Proxy band frames per track. Preferred over the sidecar spectrogram, whose low bands are too coarse for EQ. */
  bands?: Record<string, EqBandFrames | null | undefined>;
  /** Extra filters to hear on top of the saved ones, for evaluation. Keyed by track id. Saved nodes in `removed` are left out. */
  overlay?: Map<string, { global: EqFilter[]; sections: Map<string, EqFilter[]>; removed?: Set<string> }>;
}

export function buildSpectralModel(input: BuildModelInput): SpectralModel {
  const { document } = input;
  const grid = bandGrid();
  const durationSeconds = Math.max(0.001, document.project.durationSeconds);
  const stepSeconds = Math.max(MIN_STEP_SECONDS, durationSeconds / MAX_STEPS);
  const steps = Math.max(1, Math.ceil(durationSeconds / stepSeconds));
  const tracks = new Map<string, TrackSpectra>();
  const skipped: SpectralModel["skipped"] = [];
  const sectionAtStep = sectionsByStep(document.sections, steps, stepSeconds);
  for (const track of document.tracks) {
    if (track.muted) {
      skipped.push({ trackId: track.id, reason: "muted" });
      continue;
    }
    const measurement = input.measurements[track.id];
    if (!measurement) {
      skipped.push({ trackId: track.id, reason: "unmeasured" });
      continue;
    }
    const frames = usableBands(input.bands?.[track.id], grid);
    const raw = frames ? bandFramePower(frames, steps, stepSeconds) : rawBandPower(measurement, grid, steps, stepSeconds);
    if (!raw) {
      skipped.push({ trackId: track.id, reason: "unmeasured" });
      continue;
    }
    const overlay = input.overlay?.get(track.id);
    const shapes = new Map<string | null, Float64Array>();
    const shapeFor = (sectionId: string | null): Float64Array => {
      const cached = shapes.get(sectionId);
      if (cached) return cached;
      const saved = [
        ...track.processing.nodes,
        ...(sectionId ? (document.sectionTrackSettings.find((row) => row.trackId === track.id && row.sectionId === sectionId)?.processing.nodes ?? []) : []),
      ];
      const filters = [
        ...saved.filter((node) => node.enabled && !overlay?.removed?.has(node.id)).map((node) => node.filter),
        ...(overlay?.global ?? []),
        ...(sectionId ? (overlay?.sections.get(sectionId) ?? []) : []),
      ];
      const shape = new Float64Array(GRID_BANDS);
      for (let band = 0; band < GRID_BANDS; band += 1) shape[band] = bandPowerGain(filters, grid.edges[band]!, grid.edges[band + 1]!);
      shapes.set(sectionId, shape);
      return shape;
    };
    const power = new Float64Array(steps * GRID_BANDS);
    const active = new Uint8Array(steps);
    let peakStepDb = -Infinity;
    const totals = new Float64Array(steps);
    for (let step = 0; step < steps; step += 1) {
      let total = 0;
      for (let band = 0; band < GRID_BANDS; band += 1) total += raw[step * GRID_BANDS + band]!;
      totals[step] = total;
      peakStepDb = Math.max(peakStepDb, toDb(total));
    }
    for (let step = 0; step < steps; step += 1) {
      const section = sectionAtStep[step] ?? null;
      const gainDb = gainAt(document, track, section);
      const gain = 10 ** (gainDb / 10);
      const shape = shapeFor(section?.id ?? null);
      let heard = 0;
      for (let band = 0; band < GRID_BANDS; band += 1) {
        const value = raw[step * GRID_BANDS + band]! * gain * shape[band]!;
        power[step * GRID_BANDS + band] = value;
        heard += value;
      }
      const rawDb = toDb(totals[step]!);
      active[step] = rawDb >= ACTIVE_FLOOR_DB && rawDb >= peakStepDb - ACTIVE_RANGE_DB && toDb(heard) >= AUDIBLE_FLOOR_DB ? 1 : 0;
    }
    const trackShape = shapeFor(null);
    const fine = frames ? frames.fineHz.map((hz, index) => ({ hz, magnitudeDb: frames.fineDb[index] ?? -200 })) : measurement.spectrum;
    const fineSpectrum = fine.map((point) => ({
      hz: point.hz,
      db: point.magnitudeDb + toDb(trackShape[nearestBand(grid, point.hz)]!),
    }));
    tracks.set(track.id, {
      track,
      power,
      active,
      fineSpectrum,
      measurement,
      source: frames ? "proxy-bands" : "spectrogram",
      position: clamp(track.pan + (measurement.stereo.balance ?? 0), -1, 1),
      width: measurement.stereo.width ?? 0,
    });
  }
  return { grid, stepSeconds, steps, durationSeconds, tracks, skipped };
}

/** Step indexes inside [start, end). */
export function stepsIn(model: Pick<SpectralModel, "stepSeconds" | "steps">, start: number, end: number): number[] {
  const first = Math.max(0, Math.floor(start / model.stepSeconds + 1e-9));
  const last = Math.min(model.steps, Math.ceil(end / model.stepSeconds - 1e-9));
  const out: number[] = [];
  for (let step = first; step < last; step += 1) {
    const middle = (step + 0.5) * model.stepSeconds;
    if (middle >= start && middle < end) out.push(step);
  }
  return out;
}

export function toDb(power: number): number {
  return 10 * Math.log10(Math.max(power, POWER_FLOOR));
}

export function nearestBand(grid: BandGrid, hz: number): number {
  const count = grid.centers.length;
  const position = (Math.log(Math.max(GRID_LOW_HZ, Math.min(GRID_HIGH_HZ, hz)) / GRID_LOW_HZ) / Math.log(GRID_HIGH_HZ / GRID_LOW_HZ)) * count;
  return Math.min(count - 1, Math.max(0, Math.floor(position)));
}

/** Band frames only count when they use the planner's own band edges. */
function usableBands(frames: EqBandFrames | null | undefined, grid: BandGrid): EqBandFrames | null {
  if (!frames || frames.frames.length === 0 || frames.edgesHz.length !== grid.edges.length) return null;
  const matches = frames.edgesHz.every((edge, index) => Math.abs(Math.log2(edge / grid.edges[index]!)) < 0.01);
  return matches ? frames : null;
}

function bandFramePower(frames: EqBandFrames, steps: number, stepSeconds: number): Float64Array {
  const out = new Float64Array(steps * GRID_BANDS);
  for (let step = 0; step < steps; step += 1) {
    const time = (step + 0.5) * stepSeconds;
    if (time >= frames.durationSeconds) continue;
    const row = frames.frames[Math.min(frames.frames.length - 1, Math.floor(time / frames.hopSeconds))];
    if (!row) continue;
    for (let band = 0; band < GRID_BANDS; band += 1) out[step * GRID_BANDS + band] = Math.max(POWER_FLOOR, 10 ** ((row[band] ?? -200) / 10));
  }
  return out;
}

/** Spectrogram onto the shared grid. Falls back to the whole-file spectrum shaped by the loudness timeline. */
function rawBandPower(measurement: TrackFileMeasurement, grid: BandGrid, steps: number, stepSeconds: number): Float64Array | null {
  const out = new Float64Array(steps * GRID_BANDS);
  const duration = measurement.source.durationSeconds;
  const image = measurement.spectrogram;
  if (image.columns.length > 0 && image.bandCount > 1) {
    const sourceEdges = Array.from({ length: image.bandCount + 1 }, (_, index) => image.lowHz * (image.highHz / image.lowHz) ** (index / image.bandCount));
    const mapping = grid.centers.map((hz) => {
      if (hz < sourceEdges[0]! || hz > sourceEdges[sourceEdges.length - 1]!) return -1;
      let index = 0;
      while (index < image.bandCount - 1 && hz >= sourceEdges[index + 1]!) index += 1;
      return index;
    });
    const hop = image.hopSeconds > 0 ? image.hopSeconds : duration / image.columns.length;
    for (let step = 0; step < steps; step += 1) {
      const time = (step + 0.5) * stepSeconds;
      if (time >= duration) continue;
      const column = image.columns[Math.min(image.columns.length - 1, Math.floor(time / Math.max(hop, 1e-6)))];
      if (!column) continue;
      for (let band = 0; band < GRID_BANDS; band += 1) {
        const source = mapping[band]!;
        out[step * GRID_BANDS + band] = source < 0 ? POWER_FLOOR : 10 ** ((column.magnitudesDb[source] ?? -200) / 10);
      }
    }
    return out;
  }
  if (measurement.spectrum.length < 2 || measurement.loudnessTimeline.length === 0) return null;
  // Shape from the averaged spectrum, scaled so each step's total matches the loudness timeline.
  const shape = new Float64Array(GRID_BANDS);
  for (const point of measurement.spectrum) shape[nearestBand(grid, point.hz)] += 10 ** (point.magnitudeDb / 10);
  const shapeTotal = shape.reduce((sum, value) => sum + value, 0);
  if (shapeTotal <= 0) return null;
  const timeline = measurement.loudnessTimeline;
  const pointSeconds = duration / timeline.length;
  for (let step = 0; step < steps; step += 1) {
    const time = (step + 0.5) * stepSeconds;
    if (time >= duration) continue;
    const point = timeline[Math.min(timeline.length - 1, Math.floor(time / Math.max(pointSeconds, 1e-6)))];
    const rms = point?.rmsDbfs;
    if (rms === null || rms === undefined) continue;
    const total = 10 ** (rms / 10);
    for (let band = 0; band < GRID_BANDS; band += 1) out[step * GRID_BANDS + band] = Math.max(POWER_FLOOR, (shape[band]! / shapeTotal) * total);
  }
  return out;
}

function sectionsByStep(sections: readonly SongSection[], steps: number, stepSeconds: number): Array<SongSection | null> {
  return Array.from({ length: steps }, (_, step) => {
    const time = (step + 0.5) * stepSeconds;
    return sections.find((section) => time >= section.startTime && time < section.endTime) ?? null;
  });
}

function gainAt(document: ProjectDocument, track: Track, section: SongSection | null): number {
  if (!section) return track.gainDb;
  const override = document.sectionTrackSettings.find((row) => row.trackId === track.id && row.sectionId === section.id)?.overrides.gainDb;
  return override ?? track.gainDb;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
