import { FREQUENCY_BANDS, eqBandFramesSchema, trackFileMeasurementSchema, type EqBandFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { createProject, setTrackSectionState, type ProjectDocument, type SectionType, type TrackRole } from "@audiosous/project-model";

/** Deterministic measurements for planner tests: a spectral shape in dB and an on/off pattern over time. */
export const NOW = "2026-10-04T00:00:00.000Z";
const BANDS = 24;
const COLUMNS = 60;

export type Shape = (hz: number) => number;

/** Gaussian bump in log frequency. */
export function bump(centerHz: number, widthOctaves: number, heightDb: number): Shape {
  return (hz) => heightDb * Math.exp(-0.5 * (Math.log2(hz / centerHz) / widthOctaves) ** 2);
}

/** Gentle downward tilt with a floor, so every part has some energy everywhere. */
export function base(levelDb: number, tiltPerOctave = -1.5): Shape {
  return (hz) => levelDb + tiltPerOctave * Math.log2(hz / 1_000);
}

/** Power sum of separate sources, in dB. */
export function mix(...shapes: Shape[]): Shape {
  return (hz) => 10 * Math.log10(shapes.reduce((total, shape) => total + 10 ** (shape(hz) / 10), 0));
}

export function sum(...shapes: Shape[]): Shape {
  return (hz) => shapes.reduce((total, shape) => total + shape(hz), 0);
}

export interface FixtureTrack {
  shape: Shape;
  /** Seconds where the part plays. Default: the whole song. */
  active?: Array<[number, number]>;
  crest?: number;
  onsets?: number;
  balance?: number;
  width?: number;
}

export function measurementFor(fixture: FixtureTrack, duration: number): TrackFileMeasurement {
  const edges = Array.from({ length: BANDS + 1 }, (_, index) => 20 * 1_000 ** (index / BANDS));
  const centers = edges.slice(0, -1).map((low, index) => Math.sqrt(low * edges[index + 1]!));
  const on = (time: number) => (fixture.active ?? [[0, duration]]).some(([start, end]) => time >= start && time < end);
  const hop = duration / COLUMNS;
  const columns = Array.from({ length: COLUMNS }, (_, index) => {
    const time = index * hop;
    const middle = time + hop / 2;
    return {
      timeSeconds: round(time),
      magnitudesDb: centers.map((hz) => (on(middle) ? clampDb(fixture.shape(hz)) : -200)),
    };
  });
  const bandPower = centers.map((hz) => 10 ** (fixture.shape(hz) / 10));
  const total = bandPower.reduce((left, right) => left + right, 0);
  const rms = 10 * Math.log10(total);
  const crest = fixture.crest ?? 10;
  const activeShare = (fixture.active ?? [[0, duration]]).reduce((left, [start, end]) => left + (end - start), 0) / duration;
  const spectrumEdges = Array.from({ length: 49 }, (_, index) => 20 * 1_000 ** (index / 48));
  const timeline = Array.from({ length: 120 }, (_, index) => {
    const time = (index / 120) * duration;
    return { timeSeconds: round(time), rmsDbfs: on(time + duration / 240) ? round(rms) : null };
  });
  const bandEnergy = FREQUENCY_BANDS.map((band) => {
    let inside = 0;
    centers.forEach((hz, index) => {
      if (hz >= band.lowHz && hz < band.highHz) inside += bandPower[index]!;
    });
    return { ...band, normalizedEnergy: Math.round((inside / total) * 1e6) / 1e6 };
  });
  const drift = 1 - bandEnergy.reduce((left, band) => left + band.normalizedEnergy, 0);
  const largest = bandEnergy.reduce((best, band, index) => (band.normalizedEnergy > bandEnergy[best]!.normalizedEnergy ? index : best), 0);
  bandEnergy[largest] = { ...bandEnergy[largest]!, normalizedEnergy: Math.max(0, Math.min(1, bandEnergy[largest]!.normalizedEnergy + drift)) };
  return trackFileMeasurementSchema.parse({
    schemaVersion: 3,
    analysisVersion: "0.4.0",
    scope: { type: "track" },
    source: { sampleRate: 48_000, channelCount: 2, durationSeconds: duration, frameCount: Math.round(duration * 48_000) },
    levels: { peakDbfs: round(rms + crest), rmsDbfs: round(rms), integratedLufs: round(rms - 1), crestFactorDb: crest, integratedLufsStatus: "measured" },
    stereo: { balance: fixture.balance ?? 0, correlation: 0.9, width: fixture.width ?? 0.1, midRmsDbfs: round(rms), sideRmsDbfs: round(rms - 15) },
    dynamics: { dynamicRangeDb: 8, onsetDensityPerSecond: fixture.onsets ?? 1, activePercent: Math.round(activeShare * 100), silentPercent: Math.round((1 - activeShare) * 100) },
    spectral: { centroidHz: 1_000, bandwidthHz: 1_000, rolloffHz: 5_000, flatness: 0.1 },
    bandEnergy,
    spectrum: spectrumEdges.slice(0, -1).map((low, index) => {
      const hz = Math.sqrt(low * spectrumEdges[index + 1]!);
      return { hz: round(hz), magnitudeDb: clampDb(fixture.shape(hz)) };
    }),
    loudnessTimeline: timeline,
    spectrogram: { hopSeconds: round(hop), lowHz: 20, highHz: 20_000, bandCount: BANDS, columns },
  });
}

export interface SongInput {
  tracks: Array<{ id: string; name: string; role: TrackRole; gainDb?: number; pan?: number; fixture: FixtureTrack }>;
  duration?: number;
  sections?: Array<{ id: string; name: string; type: SectionType; start: number; end: number; intent?: string | null }>;
  prominence?: Array<{ track: string; section: string; prominence: "primary" | "focal" | "supporting"; intent?: string }>;
}

export function song(input: SongInput): { document: ProjectDocument; measurements: Record<string, TrackFileMeasurement> } {
  const duration = input.duration ?? 60;
  const created = createProject({
    id: "proj-eq",
    name: "EQ fixture",
    now: new Date(NOW),
    tracks: input.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      role: track.role,
      relativePath: `media/${track.id}.wav`,
      filename: `${track.id}.wav`,
      metadata: { format: "wav" as const, sampleRate: 48_000, channelCount: 2, bitDepth: 24, durationSeconds: duration, fileSizeBytes: 1_000 },
    })),
  });
  let document: ProjectDocument = {
    ...created,
    tracks: created.tracks.map((track) => {
      const spec = input.tracks.find((item) => item.id === track.id)!;
      return { ...track, gainDb: spec.gainDb ?? 0, pan: spec.pan ?? 0 };
    }),
    sections: (input.sections ?? []).map((section) => ({
      id: section.id,
      name: section.name,
      type: section.type,
      startTime: section.start,
      endTime: section.end,
      userIntent: section.intent ?? null,
      source: "manual" as const,
      confidence: null,
      structuralGroupId: null,
    })),
  };
  for (const row of input.prominence ?? []) {
    const result = setTrackSectionState(document, row.track, row.section, { prominence: row.prominence, userIntent: row.intent });
    if (!result.ok) throw new Error(result.message);
    document = result.document;
  }
  const measurements = Object.fromEntries(input.tracks.map((track) => [track.id, measurementFor(track.fixture, duration)]));
  return { document, measurements };
}

/** One section over the whole song, so prominence can be stated. */
export function wholeSong(duration = 60) {
  return [{ id: "all", name: "Chorus", type: "chorus" as const, start: 0, end: duration }];
}

function clampDb(value: number): number {
  return Math.round(Math.max(-200, Math.min(40, value)) * 100) / 100;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/* Typical parts. Levels are band powers in dB. */

export const LEAD: Shape = sum(base(-34, -2), bump(450, 1.2, 6), bump(2_800, 0.7, 12));
export const PAD_MASKING: Shape = sum(base(-38, -1), bump(2_800, 0.7, 12), bump(400, 1, 4));
export const PAD_SEPARATED: Shape = sum(base(-54, -3), bump(150, 0.6, 14));
export const KICK: Shape = sum(base(-60, -2), bump(75, 0.45, 38), bump(3_500, 0.5, 8));
export const BASS: Shape = sum(base(-60, -3), bump(80, 0.6, 36), bump(700, 0.8, 6));
export const PAD_NO_SUB: Shape = (hz: number) => sum(base(-44, -1), bump(400, 1.2, 10))(hz) - (hz < 150 ? 40 * Math.log2(150 / hz) : 0);
/** The same pad with a steady low rumble around 55 Hz, well under the kick and bass. */
export const PAD_WITH_SUB: Shape = mix(PAD_NO_SUB, (hz) => -41 - 12 * (Math.log2(hz / 55) / 0.5) ** 2);

/** Proxy band frames for a fixture: the same shape and activity, on the planner's 24-band grid. */
export function bandFramesFor(fixture: FixtureTrack, duration: number): EqBandFrames {
  const edges = Array.from({ length: BANDS + 1 }, (_, index) => 20 * 1_000 ** (index / BANDS));
  const centers = edges.slice(0, -1).map((low, index) => Math.sqrt(low * edges[index + 1]!));
  const hop = Math.max(0.25, duration / 360);
  const count = Math.ceil(duration / hop);
  const on = (time: number) => (fixture.active ?? [[0, duration]]).some(([start, end]) => time >= start && time < end);
  const fineEdges = Array.from({ length: 97 }, (_, index) => 20 * 1_000 ** (index / 96));
  const fineHz = fineEdges.slice(0, -1).map((low, index) => Math.sqrt(low * fineEdges[index + 1]!));
  return eqBandFramesSchema.parse({
    version: 1,
    sampleRate: 48_000,
    durationSeconds: duration,
    hopSeconds: hop,
    edgesHz: edges,
    frames: Array.from({ length: Math.min(count, 400) }, (_, frame) => centers.map((hz) => (on((frame + 0.5) * hop) ? clampDb(fixture.shape(hz)) : -200))),
    fineHz,
    fineDb: fineHz.map((hz) => clampDb(fixture.shape(hz))),
  });
}

/** The sidecar spectrogram of a 192 kHz stem: every band under ~150 Hz empty, their energy lumped into one band. */
export function coarseLowEnd(measurement: TrackFileMeasurement): TrackFileMeasurement {
  const columns = measurement.spectrogram.columns.map((column) => {
    const values = [...column.magnitudesDb];
    const lumped = 10 * Math.log10(values.slice(0, 8).reduce((sum, db) => sum + 10 ** (db / 10), 0) + 1e-20);
    for (let band = 0; band < 7; band += 1) values[band] = -200;
    values[7] = Math.max(-200, Math.min(40, Math.round(lumped * 100) / 100));
    return { ...column, magnitudesDb: values };
  });
  return { ...measurement, spectrogram: { ...measurement.spectrogram, columns } };
}
